import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import type { StockRecord } from '@shared/types'
import { displayDateTime, formatQuantity } from '@shared/utils'

interface Props {
  records: StockRecord[]
  deleteRecord: (id: string) => Promise<unknown>
  exportXlsx: (data: number[], defaultName: string) => Promise<{
    ok: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }>
}

export function RecordsPage({ records, deleteRecord, exportXlsx }: Props): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'in' | 'out'>('all')
  const [exporting, setExporting] = useState(false)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    let list = [...records]
    if (term) {
      list = list.filter((r) => r.name.toLowerCase().includes(term))
    }
    if (filterType !== 'all') {
      list = list.filter((r) => r.type === filterType)
    }
    // 按业务时间倒序，同一时间用写入时间兜底
    list.sort((a, b) => {
      const byTime = b.time.localeCompare(a.time)
      return byTime !== 0 ? byTime : b.createdAt.localeCompare(a.createdAt)
    })
    return list
  }, [records, search, filterType])

  const handleDelete = async (record: StockRecord): Promise<void> => {
    const msg = record.operator
      ? `确定撤销这条记录？\n\n${displayDateTime(record.time)}  ${record.name}  ${record.type === 'in' ? '入库' : '出库'} ${formatQuantity(record.quantity)} ${record.unit}\n操作人：${record.operator}`
      : `确定撤销这条记录？\n\n${displayDateTime(record.time)}  ${record.name}  ${record.type === 'in' ? '入库' : '出库'} ${formatQuantity(record.quantity)} ${record.unit}`
    // eslint-disable-next-line no-alert
    if (!window.confirm(msg)) return
    const result = await deleteRecord(record.id)
    if ((result as { ok: boolean; warning?: string }).warning) {
      // eslint-disable-next-line no-alert
      alert((result as { warning: string }).warning)
    }
  }

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const wb = XLSX.utils.book_new()
      const data = records
        .slice()
        .sort((a, b) => b.time.localeCompare(a.time) || b.createdAt.localeCompare(a.createdAt))
        .map((r) => ({
          时间: displayDateTime(r.time),
          名称: r.name,
          数量: r.quantity,
          单位: r.unit,
          操作人: r.operator || '—',
          类型: r.type === 'in' ? '入库' : '出库'
        }))
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, '出入库记录')
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      const result = await exportXlsx(Array.from(new Uint8Array(buf)), '出入库记录.xlsx')
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

  return (
    <section className="card">
      <div className="records-header">
        <h2>
          记录<span className="count">{filtered.length} 条</span>
        </h2>
        <div className="records-toolbar">
          <input
            type="text"
            className="search-input"
            placeholder="搜索物品名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="filter-group">
            {(
              [
                { key: 'all', label: '全部' },
                { key: 'in', label: '入库' },
                { key: 'out', label: '出库' }
              ] as const
            ).map((f) => (
              <button
                key={f.key}
                type="button"
                className={filterType === f.key ? 'btn btn-sm btn-active' : 'btn btn-sm'}
                onClick={() => setFilterType(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleExport}
            disabled={exporting || records.length === 0}
          >
            {exporting ? '导出中…' : '导出 Excel'}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="empty">没有匹配的记录。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>名称</th>
              <th className="num">数量</th>
              <th>单位</th>
              <th>操作人</th>
              <th>操作</th>
              <th style={{ width: 1 }} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr key={record.id}>
                <td className="mono">{displayDateTime(record.time)}</td>
                <td>{record.name}</td>
                <td className="num">{formatQuantity(record.quantity)}</td>
                <td>{record.unit}</td>
                <td
                  className="mono"
                  style={{ color: record.operator ? undefined : 'var(--text-faint)' }}
                >
                  {record.operator || '—'}
                </td>
                <td>
                  <span className={record.type === 'in' ? 'tag tag-in' : 'tag tag-out'}>
                    {record.type === 'in' ? '入库' : '出库'}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => void handleDelete(record)}
                  >
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
