import { randomUUID } from 'node:crypto'
import type {
  DeleteRecordResult,
  Item,
  StockRecord,
  TransactionInput,
  TransactionResult
} from '@shared/types'
import { normalizeName, roundQuantity, toLocalDateTime } from '@shared/utils'
import { cloneDB, commit, enqueue, load } from './db'

/**
 * 数据层的**唯一写入口**。
 *
 * 仓库页弹窗、操作页出库块、操作页入库块 —— 三处全部调用这里的函数，
 * 不允许任何一处自己拼装「写记录」和「改库存」两个动作。
 *
 * 原子性靠这个顺序保证：
 *   校验 → 基于当前快照构造一个**全新的 DB** → 原子写盘 → 写盘成功才提交内存
 * 任何一步失败，内存里的数据都还是操作之前的样子，不会出现
 * 「记录写进去了、库存却没动」这种脏数据。
 */

type Validated =
  | { ok: true; name: string; quantity: number }
  | { ok: false; error: string }

function validate(input: TransactionInput): Validated {
  const name = normalizeName(input.name ?? '')
  if (!name) return { ok: false, error: '名称不能为空' }

  const quantity = Number(input.quantity)
  if (!Number.isFinite(quantity)) return { ok: false, error: '数量必须是数字' }
  if (quantity <= 0) return { ok: false, error: '数量必须大于 0' }

  if (input.type !== 'in' && input.type !== 'out') {
    return { ok: false, error: '操作类型必须是入库或出库' }
  }

  return { ok: true, name, quantity: roundQuantity(quantity) }
}

/** 入库或出库。物品不存在时自动创建。 */
export function applyTransaction(input: TransactionInput): Promise<TransactionResult> {
  return enqueue(async () => {
    const v = validate(input)
    if (!v.ok) return v

    const current = await load()
    const next = cloneDB(current)
    const now = new Date().toISOString()

    const existing = next.items.find((i) => i.name === v.name)
    let item: Item
    let unit: string

    if (existing) {
      // 物品已存在 → **强制使用物品自身的单位，忽略调用方传来的 unit**。
      // 前端把单位输入框锁成只读只是 UI 层的事，这里才是真正的防线：
      // 即使有人绕过界面直接调 IPC，也不可能把「个」改成「盒」。
      item = existing
      unit = existing.unit
    } else {
      unit = (input.unit ?? '').trim()
      if (!unit) return { ok: false, error: '新物品必须填写单位' }

      item = {
        id: randomUUID(),
        name: v.name,
        unit,
        quantity: 0,
        createdAt: now,
        updatedAt: now
      }
      next.items.push(item)
    }

    const delta = input.type === 'in' ? v.quantity : -v.quantity
    item.quantity = roundQuantity(item.quantity + delta)
    item.updatedAt = now

    const record: StockRecord = {
      id: randomUUID(),
      itemId: item.id,
      time: input.time || toLocalDateTime(),
      // name / unit / operator 存快照：历史记录是铁证
      name: item.name,
      unit,
      quantity: v.quantity,
      type: input.type,
      operator: (input.operator ?? '').trim(),
      createdAt: now
    }
    next.records.push(record)

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    const warning =
      item.quantity < 0
        ? `「${item.name}」库存已为负（${item.quantity} ${item.unit}），请及时补货`
        : undefined

    return { ok: true, item: { ...item }, record: { ...record }, warning }
  })
}

/** 撤销一条记录，并**反向冲销**它对库存的影响。 */
export function deleteRecord(id: string): Promise<DeleteRecordResult> {
  return enqueue(async () => {
    const current = await load()
    const index = current.records.findIndex((r) => r.id === id)
    if (index < 0) return { ok: false, error: '记录不存在，可能已被删除' }

    const next = cloneDB(current)
    const [removed] = next.records.splice(index, 1)

    // 反向冲销：删掉一条入库记录要减库存，删掉一条出库记录要加库存。
    // 这正是撤销必须由数据层来做、不能让界面自己改数字的原因。
    const item = next.items.find((i) => i.id === removed.itemId)
    if (item) {
      const delta = removed.type === 'in' ? -removed.quantity : removed.quantity
      item.quantity = roundQuantity(item.quantity + delta)
      item.updatedAt = new Date().toISOString()
    }

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return {
      ok: true,
      removed: { ...removed },
      item: item ? { ...item } : null,
      warning:
        item && item.quantity < 0
          ? `「${item.name}」库存变为负数（${item.quantity} ${item.unit}）`
          : undefined
    }
  })
}
