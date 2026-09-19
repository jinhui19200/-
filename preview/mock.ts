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
  StockRecord,
  TransactionInput,
  TransactionResult
} from '@shared/types'
import { normalizeName, roundQuantity, toLocalDateTime } from '@shared/utils'

const NOW = new Date().toISOString()

let uid = 0
const nid = (p: string): string => `${p}${++uid}`

function seed(): DB {
  const items: Item[] = [
    { id: 'i1', name: 'M3×8 螺丝', unit: '个', quantity: 245, createdAt: NOW, updatedAt: NOW },
    { id: 'i2', name: '贴片电阻 10kΩ', unit: '个', quantity: 80, createdAt: NOW, updatedAt: NOW },
    { id: 'i3', name: '铜线 1.5mm²', unit: '米', quantity: -15, createdAt: NOW, updatedAt: NOW },
    { id: 'i4', name: '焊锡丝 0.8mm', unit: '卷', quantity: 12, createdAt: NOW, updatedAt: NOW },
    { id: 'i5', name: 'PCB 打样板', unit: '块', quantity: 0, createdAt: NOW, updatedAt: NOW }
  ]
  const mk = (
    itemId: string,
    time: string,
    name: string,
    unit: string,
    quantity: number,
    type: 'in' | 'out',
    operator: string
  ): StockRecord => ({
    id: nid('r'),
    itemId,
    time,
    name,
    unit,
    quantity,
    type,
    operator,
    createdAt: NOW
  })

  const records: StockRecord[] = [
    mk('i1', '2026-09-19T09:30', 'M3×8 螺丝', '个', 100, 'in', '张三'),
    mk('i1', '2026-09-19T10:00', 'M3×8 螺丝', '个', 50, 'in', '李四'),
    mk('i1', '2026-09-19T11:00', 'M3×8 螺丝', '个', 20, 'out', '张三'),
    mk('i2', '2026-09-18T14:00', '贴片电阻 10kΩ', '个', 200, 'in', ''),
    mk('i2', '2026-09-19T08:00', '贴片电阻 10kΩ', '个', 120, 'out', '王五'),
    mk('i3', '2026-09-19T13:00', '铜线 1.5mm²', '米', 30, 'in', ''),
    mk('i3', '2026-09-19T15:00', '铜线 1.5mm²', '米', 45, 'out', '李四'),
    mk('i4', '2026-09-17T16:20', '焊锡丝 0.8mm', '卷', 12, 'in', '张三'),
    mk('i1', '2026-08-20T10:00', 'M3×8 螺丝', '个', 5, 'in', '张三')
  ]

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
    item = { id: nid('i'), name, unit, quantity: 0, createdAt: stamp, updatedAt: stamp }
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

const api = {
  ping: async (): Promise<string> => 'pong',
  getSnapshot: async (): Promise<DB> => clone(),
  applyTransaction: async (input: TransactionInput): Promise<TransactionResult> =>
    applyTransaction(input),
  deleteRecord: async (id: string): Promise<DeleteRecordResult> => deleteRecord(id),
  exportXlsx: async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: '演示模式不会真的写出文件；真实应用中这里会弹出保存对话框'
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
