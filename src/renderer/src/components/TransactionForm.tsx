import { useEffect, useMemo, useRef, useState } from 'react'
import type { Item, StockRecord, TransactionInput } from '@shared/types'
import { normalizeName, toLocalDateTime } from '@shared/utils'

interface Props {
  type: 'in' | 'out'
  items: Item[]
  records: StockRecord[]
  /** 预填名称（仓库页点「出库/入库」时传入） */
  initialName?: string
  onSubmit: (input: TransactionInput) => Promise<void> | void
  onCancel?: () => void
}

export function TransactionForm({
  type,
  items,
  records,
  initialName,
  onSubmit,
  onCancel
}: Props): React.JSX.Element {
  const [time, setTime] = useState(toLocalDateTime())
  const [name, setName] = useState(initialName ?? '')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('')
  const [operator, setOperator] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const nameRef = useRef<HTMLInputElement>(null)

  // 名称对应的已存在物品（用于锁定单位）
  const matchedItem = useMemo(
    () => items.find((i) => i.name === normalizeName(name)),
    [items, name]
  )

  // 名称自动补全建议
  const nameSuggestions = useMemo(() => {
    const term = normalizeName(name)
    if (!term || matchedItem) return []
    return items
      .filter((i) => i.name.includes(term) && i.name !== term)
      .map((i) => i.name)
      .slice(0, 6)
  }, [items, name, matchedItem])

  // 操作人自动补全建议（去重，只取最近用过的）
  const operatorSuggestions = useMemo(() => {
    const term = operator.trim()
    if (!term) return []
    const seen = new Set<string>()
    const list: string[] = []
    for (const r of records) {
      if (r.operator && r.operator.includes(term) && !seen.has(r.operator)) {
        seen.add(r.operator)
        list.push(r.operator)
        if (list.length >= 6) break
      }
    }
    return list
  }, [records, operator])

  // 单位锁定：物品已存在时强制用 item.unit
  useEffect(() => {
    if (matchedItem) {
      setUnit(matchedItem.unit)
    } else if (initialName && !name) {
      setUnit('')
    }
  }, [matchedItem, initialName, name])

  const isValid =
    normalizeName(name) !== '' &&
    Number(quantity) > 0 &&
    (matchedItem ? true : unit.trim() !== '')

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!isValid || submitting) return
    setSubmitting(true)
    setError('')

    try {
      await onSubmit({
        time,
        name: normalizeName(name),
        quantity: Number(quantity),
        unit: unit.trim(),
        operator: operator.trim(),
        type
      })
      // 提交成功清空表单（保留操作人，减少重复输入）
      setTime(toLocalDateTime())
      setName('')
      setQuantity('')
      setUnit('')
      nameRef.current?.focus()
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const title = type === 'in' ? '入库' : '出库'
  const accent = type === 'in' ? 'var(--in-fg)' : 'var(--out-fg)'

  return (
    <form onSubmit={handleSubmit} className="tx-form">
      <div className="tx-field">
        <label>时间</label>
        <input
          type="datetime-local"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          required
        />
      </div>

      <div className="tx-field">
        <label>名称</label>
        <div className="tx-input-wrap">
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入物品名称"
            autoComplete="off"
            required
          />
          {nameSuggestions.length > 0 && (
            <div className="tx-suggestions">
              {nameSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tx-suggestion"
                  onClick={() => {
                    setName(s)
                    nameRef.current?.focus()
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="tx-field">
        <label>数量</label>
        <input
          type="number"
          step="0.001"
          min="0.001"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder={type === 'in' ? '入库数量' : '出库数量'}
          required
        />
      </div>

      <div className="tx-field">
        <label>单位 {matchedItem ? <span className="tx-locked">（已锁定）</span> : null}</label>
        <input
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder={matchedItem ? unit : '如：个、盒、箱'}
          readOnly={!!matchedItem}
          required={!matchedItem}
        />
      </div>

      <div className="tx-field">
        <label>操作人</label>
        <div className="tx-input-wrap">
          <input
            type="text"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            placeholder="选填，输入操作人姓名"
            autoComplete="off"
          />
          {operatorSuggestions.length > 0 && (
            <div className="tx-suggestions">
              {operatorSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tx-suggestion"
                  onClick={() => setOperator(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="tx-error">{error}</p>}

      <div className="tx-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            取消
          </button>
        )}
        <button
          type="submit"
          className="btn"
          disabled={!isValid || submitting}
          style={{ background: accent, borderColor: accent, color: '#fff' }}
        >
          {submitting ? '提交中…' : title}
        </button>
      </div>
    </form>
  )
}
