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
