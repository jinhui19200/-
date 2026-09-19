import { useEffect, useState } from 'react'

type TabKey = 'warehouse' | 'records' | 'operation'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'warehouse', label: '仓库' },
  { key: 'records', label: '记录' },
  { key: 'operation', label: '操作' }
]

export default function App() {
  const [tab, setTab] = useState<TabKey>('warehouse')
  const [bridge, setBridge] = useState('通道检测中…')

  useEffect(() => {
    // 用 Promise.resolve() 包一层：即使 window.api 不存在（例如在普通浏览器里
    // 打开渲染进程做验证），同步异常也会被转成 rejection，不会打断渲染。
    Promise.resolve()
      .then(() => window.api.ping())
      .then((r) => setBridge(`主进程通道正常（返回 ${r}）`))
      .catch(() => setBridge('未检测到主进程通道（当前非 Electron 环境）'))
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>库存管理系统</h1>
        <span className="bridge-status">{bridge}</span>
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
        {tab === 'warehouse' && (
          <Placeholder
            title="仓库"
            desc="物品列表：名称 / 数量 / 单位，每行带「出库」「入库」两个按钮。"
          />
        )}
        {tab === 'records' && (
          <Placeholder
            title="记录"
            desc="出入库流水：时间 / 名称 / 数量 / 单位 / 操作，支持搜索、筛选、撤销、导出 Excel。"
          />
        )}
        {tab === 'operation' && (
          <Placeholder
            title="操作"
            desc="出库、入库两个竖块，各自填写时间 / 名称 / 数量 / 单位，各带一个提交按钮。"
          />
        )}
      </main>
    </div>
  )
}

function Placeholder({ title, desc }: { title: string; desc: string }) {
  return (
    <section className="placeholder">
      <h2>{title}</h2>
      <p>{desc}</p>
      <p className="placeholder-note">当前为 P1 阶段：仅验证工程跑通，界面逻辑将在后续阶段实现。</p>
    </section>
  )
}
