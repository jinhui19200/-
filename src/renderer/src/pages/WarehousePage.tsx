import { useMemo, useState } from 'react'
import type { Item, StockRecord, TransactionInput, TransactionResult } from '@shared/types'
import { computeMonthlyTotals, currentMonth, formatQuantity } from '@shared/utils'
import { TransactionForm } from '../components/TransactionForm'

interface Props {
  items: Item[]
  records: StockRecord[]
  applyTransaction: (input: TransactionInput) => Promise<TransactionResult>
}

export function WarehousePage({ items, records, applyTransaction }: Props): React.JSX.Element {
  const [modalType, setModalType] = useState<'in' | 'out' | null>(null)
  const [modalName, setModalName] = useState('')

  const month = currentMonth()
  const monthLabel = `${Number(month.slice(5))}月`
  const totals = useMemo(() => computeMonthlyTotals(records, month), [records, month])

  const openModal = (type: 'in' | 'out', name: string): void => {
    setModalType(type)
    setModalName(name)
  }

  const closeModal = (): void => {
    setModalType(null)
    setModalName('')
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
      </h2>
      <table className="table">
        <thead>
          <tr>
            <th>名称</th>
            <th className="num">数量</th>
            <th>单位</th>
            <th className="num">本月入库（{monthLabel}）</th>
            <th className="num">本月出库（{monthLabel}）</th>
            <th style={{ width: 1 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const t = totals[item.id] ?? { in: 0, out: 0 }
            return (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td className={item.quantity < 0 ? 'num negative' : 'num'}>
                  {formatQuantity(item.quantity)}
                </td>
                <td>{item.unit}</td>
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
