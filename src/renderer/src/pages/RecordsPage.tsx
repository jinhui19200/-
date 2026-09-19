import type { StockRecord } from '@shared/types'
import { displayDateTime, formatQuantity } from '@shared/utils'

interface Props {
  records: StockRecord[]
}

export function RecordsPage({ records }: Props): React.JSX.Element {
  // 按业务时间倒序，同一时间用写入时间兜底，保证顺序稳定
  const sorted = [...records].sort((a, b) => {
    const byTime = b.time.localeCompare(a.time)
    return byTime !== 0 ? byTime : b.createdAt.localeCompare(a.createdAt)
  })

  if (sorted.length === 0) {
    return (
      <section className="card">
        <h2>记录</h2>
        <p className="empty">还没有出入库记录。</p>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>
        记录<span className="count">{sorted.length} 条</span>
      </h2>
      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>名称</th>
            <th className="num">数量</th>
            <th>单位</th>
            <th>操作人</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((record) => (
            <tr key={record.id}>
              <td className="mono">{displayDateTime(record.time)}</td>
              <td>{record.name}</td>
              <td className="num">{formatQuantity(record.quantity)}</td>
              <td>{record.unit}</td>
              <td className="mono" style={{ color: record.operator ? undefined : 'var(--text-faint)' }}>
                {record.operator || '—'}
              </td>
              <td>
                <span className={record.type === 'in' ? 'tag tag-in' : 'tag tag-out'}>
                  {record.type === 'in' ? '入库' : '出库'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
