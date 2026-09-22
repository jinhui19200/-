import { useMemo, useRef, useState } from 'react'
import type { Item, StockRecord } from '@shared/types'
import {
  currentMonth,
  formatQuantity,
  monthDiff,
  monthKey,
  monthLabel,
  monthlySeries,
  recentMonths
} from '@shared/utils'

/** 报表窗口：一次显示几个自然月 */
const WINDOW_MONTHS = 12

/** 拖动多少个像素算移动一个月。太小会抖，太大拖不动 */
const PX_PER_MONTH = 60

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
 * 上下两半**共用同一刻度**（取该物品窗口内所有月份的最大值）。若各自按自己的最大值缩放，
 * 一个入库 10、出库 1000 的物品会画成两根一样长的柱子，是错的。
 *
 * 时间窗口**每张卡片各自一份**，互不影响（offset 存在 ItemChart 内部）。
 * 早先所有卡片共用一个窗口，理由是「各滑各的就没法横向对比」——
 * 用起来发现正好相反：不同物料的周转节奏差得很远，A 物料三个月清空、
 * B 物料一年才动一次，共用一个窗口意味着想看 B 的历史就得把 A 一起拖进空白月份。
 * 各自独立之后，每张卡停在自己有数据的那段，反而更容易看出各自的规律。
 */
export function ReportsPage({ items, records }: Props): React.JSX.Element {
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
        <span className="report-hint">每张图表可各自按住左右拖动调整时间，互不影响</span>
      </div>

      <div className="report-grid">
        {items.map((item) => (
          <ItemChart key={item.id} item={item} records={records} />
        ))}
      </div>
    </section>
  )
}

interface ChartProps {
  item: Item
  records: StockRecord[]
}

function ItemChart({ item, records }: ChartProps): React.JSX.Element {
  /** 这张卡的窗口相对「最近 N 个月」往前推了几个月。0 = 贴着当前月 */
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null)

  /** 只属于这个物品的记录。可滑范围与「窗口外还有几个月」都只看自己 */
  const own = useMemo(() => records.filter((r) => r.itemId === item.id), [records, item.id])

  /**
   * 最多能往前推多少个月：推到**这个物品**最早一条记录所在月为止。
   *
   * 刻意不看别的物品的记录 —— 否则一个刚建的物品也能被滑到十几年前的空白窗口，
   * 而它自己根本没有任何历史可看。
   */
  const maxOffset = useMemo(() => {
    if (own.length === 0) return 0
    let earliest = monthKey(own[0].time)
    for (const r of own) {
      const m = monthKey(r.time)
      if (m < earliest) earliest = m
    }
    return Math.max(0, monthDiff(earliest, currentMonth()))
  }, [own])

  /**
   * 用钳制后的值参与渲染，而不是把 offset 存回 state。
   * 记录变少（撤销、清空）会让 maxOffset 缩水，用派生值就不需要 effect 去纠正，
   * 也不会出现「state 是 5、界面显示 2」这种不一致。
   */
  const safeOffset = Math.min(offset, maxOffset)
  const clampOffset = (v: number): number => Math.max(0, Math.min(maxOffset, v))

  const months = useMemo(() => {
    const now = new Date()
    // 锚点固定为 1 号：避免「31 号往前推一个月」落到不存在的日期上
    const anchor = new Date(now.getFullYear(), now.getMonth() - safeOffset, 1)
    return recentMonths(WINDOW_MONTHS, anchor)
  }, [safeOffset])

  const series = useMemo(
    () => monthlySeries(records, item.id, months),
    [records, item.id, months]
  )

  // 这张卡的窗口之外还有几个月的记录要明确说出来，否则用户会以为数据丢了。
  // 两侧都算：往前滑之后，右侧（更新的月份）同样会落在窗口外。
  const outsideCount = useMemo(() => {
    const first = months[0]
    const last = months[months.length - 1]
    const outside = new Set(
      own.map((r) => monthKey(r.time)).filter((m) => m < first || m > last)
    )
    return outside.size
  }, [own, months])

  // ── 拖动平移（只作用于这张卡） ──
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    dragRef.current = { startX: e.clientX, startOffset: safeOffset }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    // 往右拖 = 把时间轴往右拉 = 看到更早的数据（和拖动地图的方向一致）
    const delta = Math.round((e.clientX - d.startX) / PX_PER_MONTH)
    if (delta !== 0) setOffset(clampOffset(d.startOffset + delta))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已经释放过了，忽略 */
    }
  }

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

      {/* 这张卡自己的时间窗控制条。页面级不再有共用的工具条 */}
      <div className="report-card-bar">
        <button
          type="button"
          className="range-btn range-btn-sm"
          onClick={() => setOffset(clampOffset(safeOffset + 1))}
          disabled={safeOffset >= maxOffset}
          title="往前看一个月"
        >
          ◀ 更早
        </button>
        <span className="report-range" title="这张图当前显示的月份区间">
          {months[0]} ~ {months[months.length - 1]}
        </span>
        <button
          type="button"
          className="range-btn range-btn-sm"
          onClick={() => setOffset(clampOffset(safeOffset - 1))}
          disabled={safeOffset === 0}
          title="往后看一个月"
        >
          更晚 ▶
        </button>
        {outsideCount > 0 && (
          <span className="report-note">窗口外还有 {outsideCount} 个月的记录</span>
        )}
        {safeOffset > 0 && (
          <button
            type="button"
            className="range-btn range-btn-sm range-btn-reset"
            onClick={() => setOffset(0)}
          >
            回到最新
          </button>
        )}
      </div>

      <div
        className={`report-plot${dragging ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
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
                {/* 值为 0 不标：12 个月 × 上下两半，满屏的「0」比没有标注更难看 */}
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
