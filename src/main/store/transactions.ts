import { randomUUID } from 'node:crypto'
import type {
  DeleteRecordResult,
  Item,
  RenameItemResult,
  SetQuantityResult,
  SetThresholdResult,
  StockRecord,
  TransactionInput,
  TransactionResult
} from '@shared/types'
import {
  DEFAULT_THRESHOLD,
  matchesQuantityPassword,
  normalizeName,
  normalizeThreshold,
  roundQuantity,
  toLocalDateTime
} from '@shared/utils'
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
        threshold: DEFAULT_THRESHOLD,
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
      // name / unit / operator / handler 存快照：历史记录是铁证
      name: item.name,
      unit,
      quantity: v.quantity,
      type: input.type,
      operator: (input.operator ?? '').trim(),
      handler: (input.handler ?? '').trim(),
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

/**
 * 修改某个物品的库存警戒值。
 *
 * 刻意**不写流水**：警戒值是一个观察阈值，不是库存变动。
 * 把它记进出库记录会让「本月入库/出库」的统计和撤销逻辑全部失准。
 *
 * 非法输入（清空、负数、非数字）统一回落到默认值 100，
 * 而不是报错拒绝 —— 用户在输入框里删光重填是正常操作，
 * 那一刻的中间态不该弹错误提示。
 */
export function setItemThreshold(id: string, threshold: unknown): Promise<SetThresholdResult> {
  return enqueue(async () => {
    const current = await load()
    const target = current.items.find((i) => i.id === id)
    if (!target) return { ok: false, error: '物品不存在，可能已被删除' }

    const next = cloneDB(current)
    const item = next.items.find((i) => i.id === id) as Item
    const value = normalizeThreshold(threshold)

    // 没变就什么都不做：避免每次失焦都触发一次写盘 + 全窗口广播
    if (item.threshold === value) return { ok: true, item: { ...item } }

    item.threshold = value

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, item: { ...item } }
  })
}

/**
 * 强行修改某个物品的库存数量（需口令）。
 *
 * 这是**唯一**能凭空改库存、却不留任何流水的入口，所以几点必须写清楚：
 *
 * 1. **为什么刻意不写流水。** `StockRecord.type` 只有 in / out，没有任何合法值
 *    能表示「校正」。硬塞一条 in/out 更糟：它会被算进「本月入库/出库」的统计，
 *    撤销时还会按方向再反向冲销一遍 —— 一个凭空的差值被反复加减，
 *    账会越算越乱。代价是这次修改**在记录页查不到**，所以界面必须先过口令、
 *    并在提交前把「从多少改成多少」摆给用户看。
 *
 * 2. **允许任意有限数，包括负数和 0。** 库存允许为负是本系统既有的语义
 *    （见 applyTransaction 的负库存 warning），强行修改更不该在这里替用户把关。
 *
 * 3. **非法输入一律拒绝，不回落默认值 —— 这一点与 setItemThreshold 相反。**
 *    改警戒值时的空串是「用户正在清空重填」的中间态，回落 100 是合理的；
 *    而这里是用户明确按了「确认修改」，此刻的空串/非数字只可能是错误，
 *    静默写成某个值等于伪造了一次没人确认过的修改。
 *
 * 4. **口令校验在读盘之前。** 口令不对时连 load() 都不做：既快，
 *    也让「口令错」和「物品不存在」不可能被时序凑成同一种表现。
 */
export function setItemQuantity(
  id: string,
  rawQuantity: unknown,
  password: unknown
): Promise<SetQuantityResult> {
  return enqueue(async () => {
    // 口令规则与界面共用同一个函数（见 matchesQuantityPassword 的注释）：
    // 界面那道只是交互，这里才是绕过它直接 invoke 时唯一的防线
    if (!matchesQuantityPassword(password)) {
      return { ok: false, error: '口令不正确', wrongPassword: true }
    }

    // 空串要单独挡掉：Number('') === 0，不特判就会把「用户清空了没填」
    // 当成「改成 0」静默写进数据。与 normalizeThreshold 同款处理。
    if (rawQuantity === null || rawQuantity === undefined) {
      return { ok: false, error: '数量不能为空' }
    }
    if (typeof rawQuantity === 'string' && rawQuantity.trim() === '') {
      return { ok: false, error: '数量不能为空' }
    }

    const quantity = Number(rawQuantity)
    if (!Number.isFinite(quantity)) return { ok: false, error: '数量必须是数字' }

    const current = await load()
    const target = current.items.find((i) => i.id === id)
    if (!target) return { ok: false, error: '物品不存在，可能已被删除' }

    const next = cloneDB(current)
    const item = next.items.find((i) => i.id === id) as Item
    const value = roundQuantity(quantity)

    // 没变就什么都不做：避免白写一次盘 + 一次全窗口广播
    if (item.quantity === value) return { ok: true, item: { ...item } }

    item.quantity = value
    item.updatedAt = new Date().toISOString()

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, item: { ...item } }
  })
}

/**
 * 重命名物品。
 *
 * 这是**唯一**会去改历史记录内容的操作，所以有几点必须写清楚：
 *
 * 1. **为什么连历史记录的 name 快照一起改。**
 *    `StockRecord.name` 原本刻意存快照（「历史记录是铁证」）。但改名是个例外：
 *    名字只是这个物品的标签，不是当时的业务事实 —— 用户把「螺丝」改成
 *    「M3×8 螺丝」之后，如果记录页还显示旧名字，他会以为那是另一个物品，
 *    三页对不上。所以改名必须三页同步。
 *
 * 2. **但记录的 `unit` 快照不动。** 单位是**当时的计量事实**：
 *    一条「12 包」的历史记录，哪怕物品后来并进了按「个」计数的物品，
 *    它也确实是 12 包。改掉它就是篡改历史，而且和记录上的数量对不上。
 *
 * 3. **撞名即合并。** 新名字已被别的物品占用时，把本物品的记录搬到目标物品名下、
 *    数量累加、然后删掉本物品。**这条路径下数量可能失去物理意义**
 *    （2 个 + 12 包 = 14 个），所以单位不一致时会在返回值里带出
 *    `unitConflict`，由界面提示用户确认/改单位 —— 数据层不替用户决定。
 *    调用方可以传 `unit` 指定合并后使用的单位；不传就沿用目标物品的。
 *
 * 合并是**不可逆**的（源物品被删掉了），所以界面必须先弹确认。
 */
export function renameItem(
  id: string,
  rawName: string,
  unit?: string
): Promise<RenameItemResult> {
  return enqueue(async () => {
    const name = normalizeName(rawName ?? '')
    if (!name) return { ok: false, error: '名称不能为空' }

    const current = await load()
    if (!current.items.some((i) => i.id === id)) {
      return { ok: false, error: '物品不存在，可能已被删除' }
    }

    const next = cloneDB(current)
    const now = new Date().toISOString()
    const src = next.items.find((i) => i.id === id) as Item

    // 名字没变：什么都不做。用户在编辑框里原样回车是正常操作，
    // 不该因此触发一次写盘 + 全窗口广播。
    if (src.name === name) {
      return { ok: true, item: { ...src }, merged: false, movedRecords: 0, renamedRecords: 0 }
    }

    const target = next.items.find((i) => i.name === name && i.id !== id)

    // ── 路径一：单纯改名 ─────────────────────────────────────
    if (!target) {
      const oldName = src.name
      src.name = name
      src.updatedAt = now

      let renamedRecords = 0
      for (const r of next.records) {
        if (r.itemId !== id) continue
        r.name = name
        renamedRecords++
      }

      try {
        await commit(next)
      } catch (err) {
        return { ok: false, error: `保存失败：${String(err)}` }
      }

      return {
        ok: true,
        item: { ...src },
        merged: false,
        mergedFrom: oldName,
        movedRecords: 0,
        renamedRecords
      }
    }

    // ── 路径二：撞名，合并进 target ──────────────────────────
    const unitConflict =
      target.unit === src.unit
        ? undefined
        : { keptUnit: target.unit, otherUnit: src.unit }

    // 界面没指定就用目标物品的单位。trim 后为空串（用户清空输入框）也回落到目标单位，
    // 与 normalizeThreshold 的兜底思路一致：不让中间态写进数据。
    const chosenUnit = (unit ?? '').trim() || target.unit

    target.quantity = roundQuantity(target.quantity + src.quantity)
    target.unit = chosenUnit
    target.updatedAt = now

    let movedRecords = 0
    for (const r of next.records) {
      if (r.itemId !== id) continue
      r.itemId = target.id
      r.name = target.name
      // r.unit 刻意保持原快照 —— 见函数头注释第 2 条
      movedRecords++
    }

    next.items = next.items.filter((i) => i.id !== id)

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return {
      ok: true,
      item: { ...target },
      merged: true,
      mergedFrom: src.name,
      movedRecords,
      renamedRecords: 0,
      unitConflict,
      warning:
        target.quantity < 0
          ? `「${target.name}」合并后库存为负（${target.quantity} ${target.unit}），请及时补货`
          : undefined
    }
  })
}

export { DEFAULT_THRESHOLD }
