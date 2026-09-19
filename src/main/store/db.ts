import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '@shared/types'

/**
 * 数据文件的读写。
 *
 * 设计要点：
 * 1. **原子写入**：写同目录临时文件 → fsync → rename 覆盖。rename 在 POSIX 上是原子操作，
 *    因此不会出现「文件写了一半」的损坏状态；旧文件先留一份 .bak。
 * 2. **串行写队列**：所有写操作经同一个 Promise 队列排队，杜绝并发写互相覆盖。
 * 3. **成功才提交内存**：写入失败时内存快照保持不变，不需要回滚逻辑。
 *
 * 本模块刻意不 import electron，便于在纯 Node 环境下直接测试。
 */

const EMPTY_DB: DB = { version: 1, items: [], records: [] }

let dataFile = ''
let cache: DB | null = null

/** 串行队列的队尾 */
let queue: Promise<unknown> = Promise.resolve()

/** 初始化存储位置。主进程启动时调用一次；测试时可指向任意临时目录。 */
export function initStore(dataDir: string): void {
  dataFile = join(dataDir, 'data.json')
  cache = null
}

export function getDataFilePath(): string {
  if (!dataFile) throw new Error('存储尚未初始化，请先调用 initStore()')
  return dataFile
}

/** 同步读取当前内存快照。渲染进程取数据走这里，不碰磁盘。 */
export function getSnapshot(): DB {
  return cache ?? EMPTY_DB
}

/** 从磁盘加载。首次调用会读文件，之后走内存缓存。 */
export async function load(): Promise<DB> {
  if (cache) return cache

  try {
    const raw = await fs.readFile(getDataFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DB>
    cache = {
      version: 1,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      records: Array.isArray(parsed.records) ? parsed.records : []
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // 首次运行，还没有数据文件
      cache = { ...EMPTY_DB, items: [], records: [] }
    } else {
      // 文件存在但读不了或解析不了 —— 不能默默当成空库，否则会覆盖掉用户数据
      throw new Error(`数据文件读取失败（${getDataFilePath()}）：${String(err)}`)
    }
  }

  return cache
}

/** 原子写入并把内存快照切到新值。失败时内存保持原样。 */
export async function commit(next: DB): Promise<void> {
  const target = getDataFilePath()
  const tmp = `${target}.tmp`
  const bak = `${target}.bak`
  const json = JSON.stringify(next, null, 2)

  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(json, 'utf8')
    await handle.sync() // fsync：确保数据真正落盘，而不是停在系统缓冲区
  } finally {
    await handle.close()
  }

  // 保留上一份作为备份（首次运行时没有旧文件）
  try {
    await fs.copyFile(target, bak)
  } catch {
    /* 忽略：首次运行 */
  }

  await fs.rename(tmp, target) // 原子替换

  cache = next
}

/**
 * 把写操作排入串行队列。
 * 前一个任务失败不会阻塞后续任务（队列只关心顺序，不关心成败）。
 */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(
    () => fn(),
    () => fn()
  )
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 深拷贝一份快照，供「先构造新值、成功后再提交」的写法使用 */
export function cloneDB(db: DB): DB {
  return {
    version: 1,
    items: db.items.map((i) => ({ ...i })),
    records: db.records.map((r) => ({ ...r }))
  }
}
