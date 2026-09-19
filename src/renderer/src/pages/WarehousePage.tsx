import { useEffect, useMemo, useState } from 'react'
import type {
  Item,
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
  isBelowThreshold
} from '@shared/utils'
import { TransactionForm } from '../components/TransactionForm'

interface Props {
  items: Item[]
  records: StockRecord[]
  applyTransaction: (input: TransactionInput) => Promise<TransactionResult>
  setItemThreshold: (id: string, threshold: number) => Promise<SetThresholdResult>
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
  setItemThreshold
}: Props): React.JSX.Element {
  const [modalType, setModalType] = useState<'in' | 'out' | null>(null)
  const [modalName, setModalName] = useState('')

  const month = currentMonth()
  const monthLabel = `${Number(month.slice(5))}月`
  const totals = useMemo(() => computeMonthlyTotals(records, month), [records, month])

  const belowCount = useMemo(
    () => items.filter((i) => isBelowThreshold(i.quantity, i.threshold)).length,
    [items]
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
      <h2>
        仓库<span className="count">{items.length} 种物品</span>
        {belowCount > 0 && (
          <span className="count count-warn">{belowCount} 种低于警戒值</span>
        )}
      </h2>
      <table className="table">
        <thead>
          <tr>
            <th>名称</th>
            <th className="num">数量</th>
            <th>单位</th>
            <th className="num">警戒值</th>
            <th className="num">本月入库（{monthLabel}）</th>
            <th className="num">本月出库（{monthLabel}）</th>
            <th style={{ width: 1 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const t = totals[item.id] ?? { in: 0, out: 0 }
            const low = isBelowThreshold(item.quantity, item.threshold)
            return (
              <tr key={item.id} className={low ? 'row-low' : undefined}>
                <td>{item.name}</td>
                <td
                  className={[
                    'num',
                    item.quantity < 0 ? 'negative' : '',
                    low ? 'below-threshold' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={low ? `低于警戒值 ${formatQuantity(item.threshold)}` : undefined}
                >
                  {formatQuantity(item.quantity)}
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
    </section>
  )
}
