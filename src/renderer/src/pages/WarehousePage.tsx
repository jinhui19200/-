import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import type {
  Item,
  RenameItemResult,
  SetQuantityResult,
  SetThresholdResult,
  StockRecord,
  TransactionInput,
  TransactionResult
} from '@shared/types'
import {
  computeMonthlyTotals,
  currentMonth,
  DEFAULT_THRESHOLD,
  formatQuantity,
  isBelowThreshold,
  matchesItemQuery,
  pinMatches
} from '@shared/utils'
import { TransactionForm } from '../components/TransactionForm'
import { NameCell, useRenameFlow } from '../components/RenameName'
import { QuantityCell, useQuantityFlow } from '../components/QuantityCell'

interface Props {
  items: Item[]
  records: StockRecord[]
  applyTransaction: (input: TransactionInput) => Promise<TransactionResult>
  setItemThreshold: (id: string, threshold: number) => Promise<SetThresholdResult>
  setItemQuantity: (id: string, quantity: number, password: string) => Promise<SetQuantityResult>
  renameItem: (id: string, name: string, unit?: string) => Promise<RenameItemResult>
  exportXlsx: (data: number[], defaultName: string) => Promise<{
    ok: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }>
}

/**
 * 警戒值输入框。
 *
 * 刻意做成**非受控式提交**（输入时不落盘，失焦或回车才提交）：
 * 如果每敲一个字符就写一次盘，输入「1000」会触发 4 次原子写 + 4 次全窗口广播，
 * 而且中途的「1」「10」「100」都会被当成合法警戒值短暂生效，界面会闪。
 */
function ThresholdInput({
  item,
  onCommit
}: {
  item: Item
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(item.threshold))

  // 数据层归一化后的值回来了（例如清空输入被兜回 100），把草稿同步成真实值，
  // 否则输入框会一直显示用户敲的那个非法内容，和实际生效的值对不上。
  useEffect(() => {
    setDraft(String(item.threshold))
  }, [item.threshold])

  const commit = (): void => {
    const parsed = Number(draft)
    const value = draft.trim() === '' || !Number.isFinite(parsed) || parsed < 0 ? NaN : parsed
    // 非法输入（清空 / 负数 / 溢出）一律**回退到上一次生效的值**，不提交。
    // 刻意不做「清空 = 恢复默认 100」：用户清空输入框多半是想取消这次修改，
    // 静默替他改成 100 是越权改数据。数据层仍保留 100 兜底，防的是绕过界面直接调 IPC。
    if (Number.isNaN(value)) {
      setDraft(String(item.threshold))
      return
    }
    if (value === item.threshold) {
      setDraft(String(value))
      return
    }
    onCommit(value)
  }

  return (
    <input
      type="number"
      className="threshold-input"
      min={0}
      step={1}
      value={draft}
      aria-label={`${item.name} 的警戒值`}
      title={`库存低于这个数时标红（默认 ${DEFAULT_THRESHOLD}）`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur() // 交给 onBlur 统一提交，避免两条提交路径
        } else if (e.key === 'Escape') {
          setDraft(String(item.threshold))
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export function WarehousePage({
  items,
  records,
  applyTransaction,
  setItemThreshold,
  setItemQuantity,
  renameItem,
  exportXlsx
}: Props): React.JSX.Element {
  const [modalType, setModalType] = useState<'in' | 'out' | null>(null)
  const [modalName, setModalName] = useState('')
  const [query, setQuery] = useState('')
  const [exporting, setExporting] = useState(false)

  const rename = useRenameFlow(items, records, renameItem)
  const quantity = useQuantityFlow(items, setItemQuantity)

  const month = currentMonth()
  const monthLabel = `${Number(month.slice(5))}月`
  const totals = useMemo(() => computeMonthlyTotals(records, month), [records, month])

  const belowCount = useMemo(
    () => items.filter((i) => isBelowThreshold(i.quantity, i.threshold)).length,
    [items]
  )

  const searchActive = query.trim() !== ''

  /**
   * 搜索命中的物品**排到最前面**，其余保持原有顺序跟在后面。
   *
   * 刻意不隐藏未命中的行：仓库页是全量台账，用户搜「螺丝」时往往还要
   * 顺手核对旁边的库存；把其余行藏起来，就得反复清空搜索框才能看全。
   */
  const ordered = useMemo(() => pinMatches(items, (i) => i.name, query), [items, query])

  /** 命中的物品 id，用来给这些行加一层底色 —— 光靠「排到前面」看不出哪几行是命中的 */
  const matchedIds = useMemo(
    () => new Set(items.filter((i) => matchesItemQuery(i.name, query)).map((i) => i.id)),
    [items, query]
  )

  const openModal = (type: 'in' | 'out', name: string): void => {
    setModalType(type)
    setModalName(name)
  }

  const closeModal = (): void => {
    setModalType(null)
    setModalName('')
  }

  const handleThreshold = (item: Item, value: number): void => {
    void setItemThreshold(item.id, value).then((r) => {
      if (!r.ok) {
        // eslint-disable-next-line no-alert
        alert(`警戒值保存失败：${r.error}`)
      }
    })
  }

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const wb = XLSX.utils.book_new()
      // 导出**界面当前的顺序**（命中的在前），而不是物品的原始顺序 ——
      // 「看到什么就导出什么」才不会出现「表格里顺序对不上」的困惑。
      const data = ordered.map((item) => {
        const t = totals[item.id] ?? { in: 0, out: 0 }
        return {
          名称: item.name,
          数量: item.quantity,
          单位: item.unit,
          警戒值: item.threshold,
          [`本月入库（${monthLabel}）`]: t.in,
          [`本月出库（${monthLabel}）`]: t.out,
          // 界面上低于警戒值的行是浅红的，导出的文件里没有颜色可看，
          // 就把这个状态落成一列文字，否则导出后这条信息就丢了
          状态: isBelowThreshold(item.quantity, item.threshold) ? '低于警戒值' : ''
        }
      })
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, '仓库台账')
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      const result = await exportXlsx(Array.from(new Uint8Array(buf)), '仓库台账.xlsx')
      if (result.ok && result.path) {
        // eslint-disable-next-line no-alert
        alert(`已导出到：${result.path}`)
      } else if (!result.cancelled) {
        // eslint-disable-next-line no-alert
        alert(`导出失败：${result.error || '未知错误'}`)
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`导出异常：${String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  if (items.length === 0) {
    return (
      <section className="card">
        <h2>仓库</h2>
        <p className="empty">还没有任何物品。到「操作」页做一次入库，物品会自动建立。</p>
      </section>
    )
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2>
          仓库
          <span className="count">
            {searchActive
              ? `匹配 ${matchedIds.size} / 共 ${items.length} 种`
              : `${items.length} 种物品`}
          </span>
          {belowCount > 0 && (
            <span className="count count-warn">{belowCount} 种低于警戒值</span>
          )}
        </h2>
        <div className="card-toolbar">
          <input
            type="text"
            className="search-input"
            placeholder="搜索物品名称…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索物品"
          />
          {searchActive && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setQuery('')}
              title="清除搜索"
            >
              清除
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleExport()}
            disabled={exporting}
            title={`导出仓库台账（共 ${items.length} 种物品，按当前显示顺序）`}
          >
            {exporting ? '导出中…' : '导出 Excel'}
          </button>
        </div>
      </div>

      {/* 搜索词没命中任何物品时明说一句。表格仍照常显示全部 —— 见上面 ordered 的注释 */}
      {searchActive && matchedIds.size === 0 && (
        <p className="search-note">没有名称包含「{query.trim()}」的物品，下面是全部 {items.length} 种。</p>
      )}

      <table className="table table-cols-fixed">
        <colgroup>
          {/* 名称列不写宽度，吃掉其余列定宽之后剩下的全部空间 */}
          <col />
          <col style={{ width: 76 }} />
          <col style={{ width: 56 }} />
          <col style={{ width: 100 }} />
          <col style={{ width: 132 }} />
          <col style={{ width: 132 }} />
          <col style={{ width: 130 }} />
        </colgroup>
        <thead>
          <tr>
            <th title="双击或右键名称可以改名">名称</th>
            <th className="num" title="双击或右键数量可以强行修改（需口令）">
              数量
            </th>
            <th>单位</th>
            <th className="num">警戒值</th>
            <th className="num">本月入库（{monthLabel}）</th>
            <th className="num">本月出库（{monthLabel}）</th>
            <th style={{ width: 1 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((item) => {
            const t = totals[item.id] ?? { in: 0, out: 0 }
            const low = isBelowThreshold(item.quantity, item.threshold)
            const hit = matchedIds.has(item.id)
            return (
              <tr
                key={item.id}
                className={[low ? 'row-low' : '', hit ? 'row-hit' : ''].filter(Boolean).join(' ')}
              >
                <td>
                  <NameCell name={item.name} onRename={(next) => rename.request(item, next)} />
                </td>
                <td
                  className={[
                    'num',
                    item.quantity < 0 ? 'negative' : '',
                    low ? 'below-threshold' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <QuantityCell item={item} low={low} onRequest={quantity.request} />
                </td>
                <td>{item.unit}</td>
                <td className="num">
                  <ThresholdInput item={item} onCommit={(v) => handleThreshold(item, v)} />
                </td>
                <td className="num" style={{ color: 'var(--in-fg)' }}>
                  {t.in > 0 ? `+${formatQuantity(t.in)}` : '—'}
                </td>
                <td className="num" style={{ color: 'var(--out-fg)' }}>
                  {t.out > 0 ? `-${formatQuantity(t.out)}` : '—'}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{
                      background: 'var(--in-bg)',
                      color: 'var(--in-fg)',
                      borderColor: 'var(--in-bg)'
                    }}
                    onClick={() => openModal('in', item.name)}
                  >
                    入库
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{
                      background: 'var(--out-bg)',
                      color: 'var(--out-fg)',
                      borderColor: 'var(--out-bg)',
                      marginLeft: 6
                    }}
                    onClick={() => openModal('out', item.name)}
                  >
                    出库
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {modalType && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {modalType === 'in' ? '入库' : '出库'} — {modalName}
              </h3>
              <button type="button" className="modal-close" onClick={closeModal}>
                ×
              </button>
            </div>
            <TransactionForm
              type={modalType}
              items={items}
              records={records}
              initialName={modalName}
              onSubmit={async (input) => {
                const result = await applyTransaction(input)
                if (!result.ok) throw new Error(result.error)
                if (result.warning) {
                  // eslint-disable-next-line no-alert
                  alert(result.warning)
                }
                closeModal()
              }}
              onCancel={closeModal}
            />
          </div>
        </div>
      )}

      {rename.dialog}
      {quantity.dialog}
    </section>
  )
}
