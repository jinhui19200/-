import type { Item } from '@shared/types'
import { formatQuantity } from '@shared/utils'

interface Props {
  items: Item[]
}

export function WarehousePage({ items }: Props): React.JSX.Element {
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
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td className={item.quantity < 0 ? 'num negative' : 'num'}>
                {formatQuantity(item.quantity)}
              </td>
              <td>{item.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
