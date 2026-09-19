import type { Item, StockRecord, TransactionInput, TransactionResult } from '@shared/types'
import { TransactionForm } from '../components/TransactionForm'

interface Props {
  items: Item[]
  records: StockRecord[]
  applyTransaction: (input: TransactionInput) => Promise<TransactionResult>
}

export function OperationPage({ items, records, applyTransaction }: Props): React.JSX.Element {
  const handleSubmit = async (input: TransactionInput): Promise<void> => {
    const result = await applyTransaction(input)
    if (!result.ok) throw new Error(result.error)
    if (result.warning) {
      // eslint-disable-next-line no-alert
      alert(result.warning)
    }
  }

  return (
    <section className="card">
      <h2>操作</h2>
      <div className="operation-grid">
        <div className="operation-block" style={{ borderLeftColor: 'var(--in-fg)' }}>
          <h3 style={{ color: 'var(--in-fg)' }}>入库</h3>
          <TransactionForm
            type="in"
            items={items}
            records={records}
            onSubmit={handleSubmit}
          />
        </div>
        <div className="operation-block" style={{ borderLeftColor: 'var(--out-fg)' }}>
          <h3 style={{ color: 'var(--out-fg)' }}>出库</h3>
          <TransactionForm
            type="out"
            items={items}
            records={records}
            onSubmit={handleSubmit}
          />
        </div>
      </div>
    </section>
  )
}
