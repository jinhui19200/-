import { useMemo } from 'react'
import type { Item, StockRecord } from '@shared/types'
import { formatQuantity, monthKey, monthLabel, monthlySeries, recentMonths } from '@shared/utils'

/** 报表窗口：最近几个自然月 */
const WINDOW_MONTHS = 6

interface Props {
  items: Item[]
  records: StockRecord[]
}

/**
 * 报表页：仓库里每个物品一张卡片，卡片内是以月为横轴、数量为纵轴的**双向柱状图**。
 *
 * 为什么是上下双向而不是两组并排的柱子：
 * 入库和出库在语义上是「一进一出」两个方向，共用一条零轴能直接看出净变化 ——
 * 柱子上下差不多长说明进出基本平衡，上长下短说明在囤货。
 * 并排双柱读起来要来回比较两个不同的基线，反而费劲。
 *
 * 上下两半**共用同一刻度**（取所有月份里的最大值）。若各自按自己的最大值缩放，
 * 一个入库 10、出库 1000 的物品会画成两根一样长的柱子，是错的。
 */
export function ReportsPage({ items, records }: Props): React.JSX.Element {
  const months = useMemo(() => recentMonths(WINDOW_MONTHS), [])

  const charts = useMemo(
    () => items.map((item) => ({ item, series: monthlySeries(records, item.id, months) })),
    [items, records, months]
  )

  // 窗口之外还有历史数据的话要明确说出来，否则用户会以为数据丢了
  const hiddenMonthCount = useMemo(() => {
    const earliest = months[0]
    const older = new Set(
      records.map((r) => monthKey(r.time)).filter((m) => m < earliest)
    )
    return older.size
  }, [records, months])

  if (items.length === 0) {
    return (
      <section className="card">
        <h2>报表</h2>
        <p className="empty">还没有任何物品。到「操作」页做一次入库，物品会自动建立。</p>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>报表</h2>

      <div className="report-meta">
        <span className="legend">
          <i className="swatch swatch-in" />
          入库（轴上方）
        </span>
        <span className="legend">
          <i className="swatch swatch-out" />
          出库（轴下方）
        </span>
        <span className="report-range">
          统计区间：{months[0]} ~ {months[months.length - 1]}
        </span>
        {hiddenMonthCount > 0 && (
          <span className="report-note">另有 {hiddenMonthCount} 个月的更早数据未显示</span>
        )}
      </div>

      <div className="report-grid">
        {charts.map(({ item, series }) => (
          <ItemChart key={item.id} item={item} months={months} series={series} />
        ))}
      </div>
    </section>
  )
}

interface ChartProps {
  item: Item
  months: string[]
  series: Array<{ month: string; in: number; out: number }>
}

function ItemChart({ item, months, series }: ChartProps): React.JSX.Element {
  /**
   * 该物品在窗口内的真实峰值。0 表示这段时间完全没有出入库 ——
   * 慢周转的物料本来就可能半年不动，是个正常状态，不是异常。
   */
  const peak = Math.max(0, ...series.flatMap((r) => [r.in, r.out]))
  // 只用来避免 0 除，**不用于显示**：没有出入库时标一个「1」的刻度是纯噪音，
  // 看着还像渲染坏了。显示走 peak。
  const max = Math.max(1, peak)
  const pct = (v: number): string => `${(v / max) * 100}%`
  // 极小但非零的值按比例画出来不到 1px，给个 2px 的短桩表示「有，但很少」
  const stub = (v: number): number => (v > 0 ? 2 : 0)

  const totalIn = series.reduce((s, r) => s + r.in, 0)
  const totalOut = series.reduce((s, r) => s + r.out, 0)

  return (
    <section className="report-card">
      <header className="report-head">
        <h3 className="report-name">{item.name}</h3>
        <span className="report-unit">{item.unit}</span>
        <span className="report-total">
          <b className="t-in">入 {formatQuantity(totalIn)}</b>
          <b className="t-out">出 {formatQuantity(totalOut)}</b>
        </span>
      </header>

      <div className="report-plot">
        {/* 零轴两侧各标一次「0」会重复，只在轴下方留一个 —— 轴本身就是零线 */}
        <div className="plot-gutter plot-gutter-in">{peak > 0 && <span>{formatQuantity(peak)}</span>}</div>
        <div className="plot-gutter plot-gutter-out">
          <span>0</span>
          {peak > 0 && <span>{formatQuantity(peak)}</span>}
        </div>

        <div className="plot-half plot-in">
          {series.map((r) => (
            <div className="plot-col" key={r.month}>
              <div
                className="plot-bar bar-in"
                style={{ height: pct(r.in), minHeight: stub(r.in) }}
                title={`${r.month} 入库 ${formatQuantity(r.in)}`}
              >
                {/* 值为 0 不标：6 个月 × 上下两半，满屏的「0」比没有标注更难看 */}
                {r.in > 0 && <span className="plot-value value-in">{formatQuantity(r.in)}</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="plot-axis" />

        <div className="plot-half plot-out">
          {series.map((r) => (
            <div className="plot-col" key={r.month}>
              <div
                className="plot-bar bar-out"
                style={{ height: pct(r.out), minHeight: stub(r.out) }}
                title={`${r.month} 出库 ${formatQuantity(r.out)}`}
              >
                {r.out > 0 && <span className="plot-value value-out">{formatQuantity(r.out)}</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="plot-labels">
          {months.map((m) => (
            <span className="plot-label" key={m} title={m}>
              {monthLabel(m)}
            </span>
          ))}
        </div>

        {/*
          窗口内零出入库时给一句话。不隐藏整张图：卡片高度保持一致，
          用户也能一眼分辨「这个物品存在但没动过」和「图表没画出来」。
        */}
        {peak === 0 && <p className="plot-idle">近 {months.length} 个月无出入库</p>}
      </div>
    </section>
  )
}
