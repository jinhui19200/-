/**
 * 主进程与渲染进程共用的纯函数。
 *
 * 这些函数必须两端共用同一份实现：渲染进程要靠 `normalizeName` 判断
 * 「用户输入的名称是否已存在于物品库」（决定单位是否锁定），
 * 如果两边归一化规则不一致，就会出现界面显示锁定、数据层却当成新物品的错位。
 */

/** 名称归一化：去首尾空白，内部连续空白压成单个空格 */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/** 库存警戒值的默认值。新物品、以及旧数据里没有这个字段的物品都用它。 */
export const DEFAULT_THRESHOLD = 100

/**
 * 把任意输入归一成合法的警戒值。
 *
 * 非法输入（空串、NaN、负数）一律回落到默认值而不是抛错 ——
 * 用户正在输入框里清空重填时，中途的空串是正常状态，
 * 不该让界面炸掉，也不该把 0 偷偷写进数据。
 */
export function normalizeThreshold(raw: unknown): number {
  // 空串要单独挡掉：Number('') === 0，不特判就会把「用户清空输入框」
  // 当成「警戒值设为 0」，静默写进数据。
  if (raw === null || raw === undefined) return DEFAULT_THRESHOLD
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_THRESHOLD

  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_THRESHOLD
  return roundQuantity(n)
}

/** 库存是否低于警戒值（界面据此标红） */
export function isBelowThreshold(quantity: number, threshold: number): boolean {
  return quantity < normalizeThreshold(threshold)
}

/** 数量保留 3 位小数，避免浮点累加产生 0.30000000000000004 这类脏值 */
export function roundQuantity(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** 把数量格式化成界面展示用的字符串（去掉多余的 0） */
export function formatQuantity(n: number): string {
  return String(roundQuantity(n))
}

/**
 * 本地时间格式化为 `YYYY-MM-DDTHH:mm`，正好是 `<input type="datetime-local">` 的取值格式。
 *
 * 刻意不用 ISO/UTC：这是个纯本地记账工具，用户填的是「我这边几点几分」，
 * 转成 UTC 再转回来只会在跨时区或夏令时上引入偏移，没有收益。
 */
export function toLocalDateTime(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** 把 `YYYY-MM-DDTHH:mm` 显示成 `YYYY-MM-DD HH:mm`，用于列表展示 */
export function displayDateTime(value: string): string {
  return value.replace('T', ' ')
}

/**
 * 从 `YYYY-MM-DDTHH:mm` 提取自然月标识：`YYYY-MM`。
 * 月度统计用此作为分组键。
 */
export function monthKey(value: string): string {
  return value.slice(0, 7) // 'YYYY-MM'
}

/** 当前自然月的标识，如 `2026-09` */
export function currentMonth(): string {
  return monthKey(toLocalDateTime())
}

/**
 * 按自然月统计每个物品的入库、出库总量。
 * 返回 `{ [itemId]: { in: number, out: number } }`。
 */
export function computeMonthlyTotals(
  records: Array<{ itemId: string; time: string; quantity: number; type: 'in' | 'out' }>,
  month: string
): Record<string, { in: number; out: number }> {
  const map: Record<string, { in: number; out: number }> = {}
  for (const r of records) {
    if (monthKey(r.time) !== month) continue
    const cur = map[r.itemId] ?? { in: 0, out: 0 }
    cur[r.type] = roundQuantity(cur[r.type] + r.quantity)
    map[r.itemId] = cur
  }
  return map
}

/** 月份标识 `YYYY-MM` 的中文短标签，如 `2026-09` → `9月` */
export function monthLabel(month: string): string {
  return `${Number(month.slice(5))}月`
}

/**
 * 最近 count 个自然月，**从早到晚**排列（最后一项是当月）。
 *
 * 用 `new Date(y, m - i, 1)` 逐月回推而不是自己算减法：
 * 月份为负数时 Date 会自动向年份借位，跨年边界不用特判。
 * 同时把日期固定为 1 号，避免「31 号往前推一个月」落到不存在的日期上。
 */
export function recentMonths(count: number, from: Date = new Date()): string[] {
  const out: string[] = []
  const y = from.getFullYear()
  const m = from.getMonth()
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(y, m - i, 1)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

/**
 * 两个 `YYYY-MM` 之间相差的月数。`to` 晚于 `from` 时为正，早于时为负。
 *
 * 用「年×12 + 月」的差值算，而不是对 Date 做减法：
 * Date 相减得到的是毫秒，各月天数不同，除以 30 天会算出 0.97 个月这种结果，
 * 取整后边界月份会随机偏一格。
 */
export function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}

/**
 * 某个物品在各月的入库/出库合计，顺序与传入的 months 完全一致。
 *
 * 返回定长数组（没有记录的月份补 0），这样界面直接按下标画柱、
 * 不必再判断某个月缺不缺数据。
 */
export function monthlySeries(
  records: Array<{ itemId: string; time: string; quantity: number; type: 'in' | 'out' }>,
  itemId: string,
  months: string[]
): Array<{ month: string; in: number; out: number }> {
  const index = new Map(months.map((m, i) => [m, i]))
  const rows = months.map((month) => ({ month, in: 0, out: 0 }))

  for (const r of records) {
    if (r.itemId !== itemId) continue
    const i = index.get(monthKey(r.time))
    if (i === undefined) continue // 落在窗口之外的历史记录，忽略
    rows[i][r.type] = roundQuantity(rows[i][r.type] + r.quantity)
  }
  return rows
}
