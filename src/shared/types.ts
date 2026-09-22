/** 出入库方向 */
export type TransactionType = 'in' | 'out'

/** 物品（库存台账的一行） */
export interface Item {
  id: string
  /** 归一化后的名称（去首尾空格、内部连续空格压成一个） */
  name: string
  /** 单位。物品创建后由数据层锁定，不随出入库变动 */
  unit: string
  /** 当前库存。允许为负（出库超过库存时只警告不阻断） */
  quantity: number
  /**
   * 库存警戒值。当前库存**低于**它时，仓库页把数量标成浅红。
   * 默认 {@link DEFAULT_THRESHOLD}（100）；旧数据文件没有这个字段，
   * 加载时由数据层补齐，不需要用户手动迁移。
   */
  threshold: number
  createdAt: string
  updatedAt: string
}

/** 一条出入库流水。name / unit 存的是**快照**，历史记录不受物品当前状态影响 */
export interface StockRecord {
  id: string
  itemId: string
  /** 用户填写的业务时间，格式 `YYYY-MM-DDTHH:mm`（本地时间，不带时区） */
  time: string
  /** 名称快照 */
  name: string
  /** 单位快照 */
  unit: string
  /** 数量，恒为正数，方向由 type 决定 */
  quantity: number
  type: TransactionType
  /** 操作人快照（选填）。空串表示未填 */
  operator: string
  /**
   * 货品交接人快照（选填）。空串表示未填。
   *
   * 语义随 type 变化：入库是**经手人**（货交到谁手上），出库是**领取人**（货被谁领走）。
   * 两种角色不会同时出现在一条记录上，所以存**同一个字段**而不是两个 ——
   * 两个字段必然一个恒为空，查询、导出、断言都要处处判断「该看哪个」。
   * 界面按 type 决定标签文案，数据层不关心。
   *
   * 与 {@link operator} 并存：操作人是「谁在系统里录的账」，
   * 本字段是「货实际交给了谁」，二者可以是同一个人，也可以不是。
   */
  handler: string
  /** 机器写入时间（ISO），用于审计与排序兜底 */
  createdAt: string
}

export interface DB {
  version: 1
  items: Item[]
  records: StockRecord[]
}

/** 出入库请求参数 */
export interface TransactionInput {
  time: string
  name: string
  quantity: number
  /**
   * 单位。**仅在新物品首次创建时生效**；
   * 物品已存在时数据层会忽略此值，强制使用 item.unit。
   */
  unit?: string
  /** 操作人（选填） */
  operator?: string
  /**
   * 货品交接人（选填）。入库填「经手人」、出库填「领取人」，
   * 界面按 type 决定标签，数据层原样存快照。
   */
  handler?: string
  type: TransactionType
}

export type TransactionResult =
  | {
      ok: true
      item: Item
      record: StockRecord
      /** 非致命提示，例如「库存已为负」 */
      warning?: string
    }
  | { ok: false; error: string }

export type DeleteRecordResult =
  | { ok: true; removed: StockRecord; item: Item | null; warning?: string }
  | { ok: false; error: string }

/** 修改物品警戒值 */
export type SetThresholdResult = { ok: true; item: Item } | { ok: false; error: string }
