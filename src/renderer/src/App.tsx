import { useEffect, useState } from 'react'
import { useAppData } from './hooks/useAppData'
import { OperationPage } from './pages/OperationPage'
import { RecordsPage } from './pages/RecordsPage'
import { WarehousePage } from './pages/WarehousePage'

type TabKey = 'warehouse' | 'records' | 'operation'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'warehouse', label: '仓库' },
  { key: 'records', label: '记录' },
  { key: 'operation', label: '操作' }
]

export default function App() {
  const [tab, setTab] = useState<TabKey>('warehouse')
  const [bridge, setBridge] = useState('通道检测中…')
  const { db, ready, error, applyTransaction, deleteRecord, exportXlsx } = useAppData()

  useEffect(() => {
    Promise.resolve()
      .then(() => window.api.ping())
      .then((r) => setBridge(`主进程通道正常（返回 ${r}）`))
      .catch(() => setBridge('未检测到主进程通道（当前非 Electron 环境）'))
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>库存管理系统</h1>
        <span className="bridge-status">
          {error ? `数据读取异常：${error}` : bridge}
        </span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={t.key === tab ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {!ready && <p className="loading">正在读取数据…</p>}
        {ready && tab === 'warehouse' && (
          <WarehousePage
            items={db.items}
            records={db.records}
            applyTransaction={applyTransaction}
          />
        )}
        {ready && tab === 'records' && (
          <RecordsPage
            records={db.records}
            deleteRecord={deleteRecord}
            exportXlsx={exportXlsx}
          />
        )}
        {ready && tab === 'operation' && (
          <OperationPage
            items={db.items}
            records={db.records}
            applyTransaction={applyTransaction}
          />
        )}
      </main>
    </div>
  )
}
