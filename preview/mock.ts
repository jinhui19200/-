/**
 * 浏览器预览用的内存版数据后端。
 *
 * 它镜像主进程 store 的语义（名称归一化、单位锁定、负库存警告、撤销反向冲销），
 * 只是把「原子写盘」换成「存在内存里」。这样界面行为与真实应用一致，
 * 可以放心用来点着看效果。
 */
import type {
  DB,
  DeleteRecordResult,
  Item,
  SetThresholdResult,
  StockRecord,
  TransactionInput,
  TransactionResult
} from '@shared/types'
import {
  DEFAULT_THRESHOLD,
  normalizeName,
  normalizeThreshold,
  roundQuantity,
  toLocalDateTime
} from '@shared/utils'

const NOW = new Date().toISOString()

let uid = 0
const nid = (p: string): string => `${p}${++uid}`

function seed(): DB {
  const items: Item[] = [
    // 刻意让几种状态都出现：高于警戒值、低于警戒值、负数、正好为 0。
    // 注意别在这里加「排针」—— 界面自检的「新建物品」用例要靠它不存在才能跑通。
    { id: 'i1', name: 'M3×8 螺丝', unit: '个', quantity: 245, threshold: 100, createdAt: NOW, updatedAt: NOW },
    { id: 'i2', name: '贴片电阻 10kΩ', unit: '个', quantity: 80, threshold: 100, createdAt: NOW, updatedAt: NOW },
    { id: 'i3', name: '铜线 1.5mm²', unit: '米', quantity: -15, threshold: 50, createdAt: NOW, updatedAt: NOW },
    { id: 'i4', name: '焊锡丝 0.8mm', unit: '卷', quantity: 12, threshold: 10, createdAt: NOW, updatedAt: NOW },
    { id: 'i5', name: 'PCB 打样板', unit: '块', quantity: 0, threshold: 5, createdAt: NOW, updatedAt: NOW },
    // 窗口内零出入库：报表页要显示「近 N 个月无出入库」而不是一个空刻度。
    // 库存刻意设为**高于**警戒值 —— 让「零出入库」和「低于警戒值」两个状态保持正交，
    // 否则它会连带扰动所有跟低库存有关的计数断言，排查时容易误判。
    { id: 'i9', name: '闲置物料 X', unit: '个', quantity: 50, threshold: 10, createdAt: NOW, updatedAt: NOW }
  ]
  const mk = (
    itemId: string,
    time: string,
    name: string,
    unit: string,
    quantity: number,
    type: 'in' | 'out',
    operator: string,
    handler = ''
  ): StockRecord => ({
    id: nid('r'),
    itemId,
    time,
    name,
    unit,
    quantity,
    type,
    operator,
    handler,
    createdAt: NOW
  })

  const records: StockRecord[] = [
    // 前几条刻意带上「经手人 / 领取人」：记录页要有一列显示它，
    // 全空的话断言只能验「列存在」，验不了「值取对了」。
    mk('i1', '2026-09-19T09:30', 'M3×8 螺丝', '个', 100, 'in', '张三', '赵六'),
    mk('i1', '2026-09-19T10:00', 'M3×8 螺丝', '个', 50, 'in', '李四', '赵六'),
    mk('i1', '2026-09-19T11:00', 'M3×8 螺丝', '个', 20, 'out', '张三', '孙八'),
    mk('i2', '2026-09-18T14:00', '贴片电阻 10kΩ', '个', 200, 'in', ''),
    mk('i2', '2026-09-19T08:00', '贴片电阻 10kΩ', '个', 120, 'out', '王五', '周九'),
    mk('i3', '2026-09-19T13:00', '铜线 1.5mm²', '米', 30, 'in', ''),
    mk('i3', '2026-09-19T15:00', '铜线 1.5mm²', '米', 45, 'out', '李四'),
    mk('i4', '2026-09-17T16:20', '焊锡丝 0.8mm', '卷', 12, 'in', '张三'),
    mk('i1', '2026-08-20T10:00', 'M3×8 螺丝', '个', 5, 'in', '张三'),

    // 更早几个月的数据，专门喂给报表页的月度柱状图 ——
    // 否则 6 个月里只有 2 个月有柱子，看不出图表的实际效果。
    // 刻意避开 08-20 与 09-17 ~ 09-19：记录页的日期筛选断言依赖那几天的条数。
    mk('i1', '2026-06-12T09:00', 'M3×8 螺丝', '个', 300, 'in', '张三'),
    mk('i2', '2026-06-20T14:30', '贴片电阻 10kΩ', '个', 500, 'in', '李四'),
    mk('i4', '2026-06-28T11:10', '焊锡丝 0.8mm', '卷', 40, 'in', ''),
    mk('i3', '2026-07-03T09:45', '铜线 1.5mm²', '米', 120, 'in', '李四'),
    mk('i1', '2026-07-08T10:20', 'M3×8 螺丝', '个', 150, 'out', '张三'),
    mk('i2', '2026-07-15T16:00', '贴片电阻 10kΩ', '个', 260, 'out', '王五'),
    mk('i5', '2026-07-22T13:30', 'PCB 打样板', '块', 30, 'in', '张三'),
    mk('i2', '2026-08-11T15:20', '贴片电阻 10kΩ', '个', 180, 'out', '王五'),

    // 再往前铺满 12 个月。报表页默认窗口就是 12 个月，
    // 只有 6~9 月有数据的话左边三分之二全空，默认视图看着像坏了。
    // 顺带让「往前滑」有足够的历史可滑 —— 可滑范围 = 最早记录所在月到当前月。
    // 日期都落在 2025-10 ~ 2026-05，离记录页筛选断言依赖的那几天很远。
    mk('i1', '2025-10-14T09:20', 'M3×8 螺丝', '个', 200, 'in', '张三'),
    mk('i2', '2025-10-27T15:40', '贴片电阻 10kΩ', '个', 300, 'in', '李四'),
    mk('i3', '2025-11-06T10:10', '铜线 1.5mm²', '米', 80, 'in', '李四'),
    mk('i1', '2025-11-19T14:05', 'M3×8 螺丝', '个', 90, 'out', '张三'),
    mk('i4', '2025-12-03T11:30', '焊锡丝 0.8mm', '卷', 25, 'in', ''),
    mk('i2', '2025-12-16T16:45', '贴片电阻 10kΩ', '个', 150, 'out', '王五'),
    mk('i5', '2026-01-09T09:00', 'PCB 打样板', '块', 20, 'in', '张三'),
    mk('i1', '2026-01-22T13:15', 'M3×8 螺丝', '个', 260, 'in', '李四'),
    mk('i3', '2026-02-05T10:40', '铜线 1.5mm²', '米', 60, 'out', '王五'),
    mk('i2', '2026-02-18T15:25', '贴片电阻 10kΩ', '个', 400, 'in', '李四'),
    mk('i4', '2026-03-11T09:50', '焊锡丝 0.8mm', '卷', 15, 'out', '张三'),
    mk('i1', '2026-03-24T14:35', 'M3×8 螺丝', '个', 120, 'out', '王五'),
    mk('i5', '2026-04-08T11:05', 'PCB 打样板', '块', 45, 'in', '李四'),
    mk('i2', '2026-04-21T16:20', '贴片电阻 10kΩ', '个', 220, 'out', '王五'),
    mk('i3', '2026-05-13T10:30', '铜线 1.5mm²', '米', 150, 'in', '张三'),
    mk('i1', '2026-05-26T15:10', 'M3×8 螺丝', '个', 180, 'in', '李四')
  ]

  // ?seed=N 额外灌 N 条记录，用来观察「记录攒多了」时界面的表现
  const seedParam = Number(new URLSearchParams(location.search).get('seed') ?? 0)
  if (Number.isFinite(seedParam) && seedParam > 0) {
    const n = Math.min(Math.floor(seedParam), 50000)
    for (let i = 0; i < n; i++) {
      const it = items[i % items.length]
      const day = String((i % 28) + 1).padStart(2, '0')
      const hh = String(i % 24).padStart(2, '0')
      const mm = String((i * 7) % 60).padStart(2, '0')
      records.push(
        mk(
          it.id,
          `2026-09-${day}T${hh}:${mm}`,
          it.name,
          it.unit,
          (i % 20) + 1,
          i % 3 === 0 ? 'out' : 'in',
          `员工${(i % 7) + 1}`
        )
      )
    }
  }

  return { version: 1, items, records }
}

let db: DB = seed()

let subSeq = 0
const subs = new Map<number, () => void>()
function notify(): void {
  for (const fn of subs.values()) fn()
}

function clone(): DB {
  return {
    version: 1,
    items: db.items.map((i) => ({ ...i })),
    records: db.records.map((r) => ({ ...r }))
  }
}

function applyTransaction(input: TransactionInput): TransactionResult {
  const name = normalizeName(input.name ?? '')
  if (!name) return { ok: false, error: '名称不能为空' }

  const qty = Number(input.quantity)
  if (!Number.isFinite(qty)) return { ok: false, error: '数量必须是数字' }
  if (qty <= 0) return { ok: false, error: '数量必须大于 0' }

  if (input.type !== 'in' && input.type !== 'out') {
    return { ok: false, error: '操作类型必须是入库或出库' }
  }

  const quantity = roundQuantity(qty)
  const next = clone()
  const stamp = new Date().toISOString()

  const existing = next.items.find((i) => i.name === name)
  let item: Item
  let unit: string

  if (existing) {
    // 与数据层一致：物品已存在则强制沿用其单位
    item = existing
    unit = existing.unit
  } else {
    unit = (input.unit ?? '').trim()
    if (!unit) return { ok: false, error: '新物品必须填写单位' }
    item = {
      id: nid('i'),
      name,
      unit,
      quantity: 0,
      threshold: DEFAULT_THRESHOLD,
      createdAt: stamp,
      updatedAt: stamp
    }
    next.items.push(item)
  }

  const delta = input.type === 'in' ? quantity : -quantity
  item.quantity = roundQuantity(item.quantity + delta)
  item.updatedAt = stamp

  const record: StockRecord = {
    id: nid('r'),
    itemId: item.id,
    time: input.time || toLocalDateTime(),
    name: item.name,
    unit,
    quantity,
    type: input.type,
    operator: (input.operator ?? '').trim(),
    handler: (input.handler ?? '').trim(),
    createdAt: stamp
  }
  next.records.push(record)

  db = next
  notify()

  return {
    ok: true,
    item: { ...item },
    record: { ...record },
    warning:
      item.quantity < 0
        ? `「${item.name}」库存已为负（${item.quantity} ${item.unit}），请及时补货`
        : undefined
  }
}

function deleteRecord(id: string): DeleteRecordResult {
  const index = db.records.findIndex((r) => r.id === id)
  if (index < 0) return { ok: false, error: '记录不存在，可能已被删除' }

  const next = clone()
  const [removed] = next.records.splice(index, 1)

  const item = next.items.find((i) => i.id === removed.itemId)
  if (item) {
    const delta = removed.type === 'in' ? -removed.quantity : removed.quantity
    item.quantity = roundQuantity(item.quantity + delta)
    item.updatedAt = new Date().toISOString()
  }

  db = next
  notify()

  return {
    ok: true,
    removed: { ...removed },
    item: item ? { ...item } : null,
    warning:
      item && item.quantity < 0
        ? `「${item.name}」库存变为负数（${item.quantity} ${item.unit}）`
        : undefined
  }
}

function setItemThreshold(id: string, threshold: number): SetThresholdResult {
  const item = db.items.find((i) => i.id === id)
  if (!item) return { ok: false, error: '物品不存在，可能已被删除' }

  const next = clone()
  const target = next.items.find((i) => i.id === id) as Item
  const value = normalizeThreshold(threshold)
  if (target.threshold === value) return { ok: true, item: { ...target } }

  target.threshold = value
  db = next
  notify()
  return { ok: true, item: { ...target } }
}

const api = {
  ping: async (): Promise<string> => 'pong',
  getSnapshot: async (): Promise<DB> => clone(),
  applyTransaction: async (input: TransactionInput): Promise<TransactionResult> =>
    applyTransaction(input),
  deleteRecord: async (id: string): Promise<DeleteRecordResult> => deleteRecord(id),
  setItemThreshold: async (id: string, threshold: number): Promise<SetThresholdResult> =>
    setItemThreshold(id, threshold),
  exportXlsx: async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: '演示模式不会真的写出文件；真实应用中这里会弹出保存对话框'
  }),
  // 带 ?recovered=1 打开即可预览「已从备份恢复」提示条的样子
  getLoadReport: async (): Promise<{ recoveredFromBackup: boolean }> => ({
    recoveredFromBackup: new URLSearchParams(location.search).has('recovered')
  }),
  getDataPath: async (): Promise<string> => '（演示模式：数据只存在浏览器内存里，没有文件）',
  openDataFolder: async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: '演示模式没有数据文件夹'
  }),
  onChanged: (cb: () => void): number => {
    const id = ++subSeq
    subs.set(id, cb)
    return id
  },
  offChanged: (id: number): void => {
    subs.delete(id)
  }
}

;(window as unknown as { api: unknown }).api = api

function mountBanner(): void {
  const el = document.createElement('div')
  el.textContent = '演示模式 · 数据仅存于浏览器内存，刷新即重置'
  el.style.cssText = [
    'position:fixed',
    'right:14px',
    'bottom:14px',
    'z-index:9999',
    'padding:6px 12px',
    'border-radius:999px',
    'background:rgba(31,35,41,0.82)',
    'color:#fff',
    'font-size:12px',
    'line-height:1.6',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
    'pointer-events:none',
    'box-shadow:0 4px 14px rgba(0,0,0,0.18)'
  ].join(';')
  document.body.appendChild(el)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountBanner)
} else {
  mountBanner()
}
