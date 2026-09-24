import { useCallback, useEffect, useRef, useState } from 'react'
import type { Item, SetQuantityResult } from '@shared/types'
import { formatQuantity, matchesQuantityPassword } from '@shared/utils'
import { ContextMenu } from './ContextMenu'

/**
 * 数量单元格：双击 / 右键 → 「修改数量」对话框。
 *
 * 对话框刻意分**两步**：先口令、后数字。
 *
 * 为什么不把口令和数字放同一屏一起提交：那样「数字」在口令验证之前就已经
 * 是用户敲进去的状态，界面等于先允许改、再回头验 —— 一旦口令错，
 * 用户已经建立「我要改成 X」的心理预期，很容易反复重试口令直到蒙对。
 * 分两步后，数字输入框在口令正确之前**根本不存在**，
 * 「验证在前、改数在后」是物理事实，不靠流程约定。
 *
 * 口令在第一步由界面即时比对（判定规则与数据层共用同一个 `matchesQuantityPassword`），
 * 提交时再把口令一起送到数据层**再验一次** —— 界面这道只是交互，
 * 绕过它直接调 IPC 依然会被拒。
 */

interface DialogProps {
  item: Item
  onCancel: () => void
  onSubmit: (quantity: number, password: string) => Promise<SetQuantityResult>
}

function QuantityDialog({ item, onCancel, onSubmit }: DialogProps): React.JSX.Element {
  const [step, setStep] = useState<'password' | 'quantity'>('password')
  const [password, setPassword] = useState('')
  const [draft, setDraft] = useState(formatQuantity(item.quantity))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const pwdRef = useRef<HTMLInputElement>(null)
  const qtyRef = useRef<HTMLInputElement>(null)

  // 进入某一步就聚焦对应的输入框；第二步顺手全选，用户直接敲数字就能覆盖
  useEffect(() => {
    if (step === 'password') {
      pwdRef.current?.focus()
    } else {
      qtyRef.current?.focus()
      qtyRef.current?.select()
    }
  }, [step])

  const checkPassword = (): void => {
    // 与数据层共用同一个判定函数，不是「各写一遍规则」——
    // 否则界面放行、写盘被拒这种脱节迟早会出现
    if (!matchesQuantityPassword(password)) {
      setError('口令不正确')
      setPassword('')
      pwdRef.current?.focus()
      return
    }
    setError('')
    setStep('quantity')
  }

  const submit = async (): Promise<void> => {
    const parsed = Number(draft)
    // 空串要单独挡：Number('') === 0，不特判就会把「清空了没填」当成「改成 0」
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setError('请输入一个数字')
      return
    }

    setBusy(true)
    const result = await onSubmit(parsed, password)

    // 成功时调用方已经把这个对话框卸载了，这里**不能再 setState** ——
    // 对已卸载组件写状态虽然不再报警告，但会让人误以为这个分支还有活干。
    if (result.ok) return

    setBusy(false)
    if (result.wrongPassword) {
      /*
       * 数据层说口令不对，但界面刚刚才用同一个常量放行过 ——
       * 说明两边的口令已经脱节（比如界面那份是旧的）。这种情况必须退回第一步重来，
       * 而不是在数字框上提示「口令不对」：那个框里根本没有口令可改。
       */
      setStep('password')
      setPassword('')
      setError('口令不正确，请重新输入')
      return
    }
    setError(result.error)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>修改数量 — {item.name}</h3>
          <button type="button" className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {step === 'password' ? (
            <>
              <p className="modal-text">
                「{item.name}」当前 {formatQuantity(item.quantity)} {item.unit}。
                修改库存数量需要口令。
              </p>
              <input
                ref={pwdRef}
                type="password"
                className="qty-edit-input"
                value={password}
                aria-label="修改数量口令"
                autoComplete="off"
                onChange={(e) => {
                  setPassword(e.target.value)
                  setError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    checkPassword()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancel()
                  }
                }}
              />
            </>
          ) : (
            <>
              <p className="modal-text">
                「{item.name}」当前 {formatQuantity(item.quantity)} {item.unit}，要改成：
              </p>
              <input
                ref={qtyRef}
                type="number"
                step="any"
                className="qty-edit-input"
                value={draft}
                aria-label="新的库存数量"
                onChange={(e) => {
                  setDraft(e.target.value)
                  setError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submit()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancel()
                  }
                }}
              />
              <p className="modal-note">
                这是<strong>强行改数</strong>：不会写进出库记录，「记录」页和月度报表都看不到
                这次改动，只认最后这个数字。允许填负数。
              </p>
            </>
          )}

          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              if (step === 'password') checkPassword()
              else void submit()
            }}
          >
            {step === 'password' ? '继续' : busy ? '保存中…' : '确认修改'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 数量单元格本体：只负责「显示数字」和「怎么唤起对话框」 */
export function QuantityCell({
  item,
  low,
  onRequest
}: {
  item: Item
  /** 是否低于警戒值（由调用方算好传进来，避免同一行算两遍） */
  low: boolean
  onRequest: (item: Item) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // 低于警戒值时鼠标悬停原本要显示警戒值，现在把「怎么改」一并带上 ——
  // 直接覆盖掉的话，用户就看不到这一行为什么是红的了
  const hint = '双击或右键修改数量（需口令）'
  const title = low
    ? `低于警戒值 ${formatQuantity(item.threshold)} · ${hint}`
    : hint

  return (
    <>
      <span
        className="qty-text"
        title={title}
        onDoubleClick={() => onRequest(item)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {formatQuantity(item.quantity)}
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{ label: '修改数量', onClick: () => onRequest(item) }]}
        />
      )}
    </>
  )
}

export interface QuantityFlow {
  /** 发起修改。会弹出「先口令、后数字」的两步对话框 */
  request: (item: Item) => void
  /** 需要时渲染的对话框（没在改数量时是 null） */
  dialog: React.JSX.Element | null
}

/**
 * @param items 当前全部物品。对话框只存 id，每次渲染时按 id 重新取物品 ——
 *              这样别的窗口改了数、或这个物品被并掉，对话框里显示的都是最新的，
 *              物品没了对话框还会自己消失。
 * @param setItemQuantity 数据层的改数入口（口令由它再校验一次）
 */
export function useQuantityFlow(
  items: Item[],
  setItemQuantity: (id: string, quantity: number, password: string) => Promise<SetQuantityResult>
): QuantityFlow {
  const [pendingId, setPendingId] = useState<string | null>(null)

  const pending = pendingId ? (items.find((i) => i.id === pendingId) ?? null) : null

  const request = useCallback((item: Item): void => {
    setPendingId(item.id)
  }, [])

  const submit = useCallback(
    async (quantity: number, password: string): Promise<SetQuantityResult> => {
      if (!pending) return { ok: false, error: '物品已不存在，请重新打开' }
      const result = await setItemQuantity(pending.id, quantity, password)
      // 成功即关窗；失败交给对话框自己显示原因（它要区分「口令错」和「数字非法」）
      if (result.ok) setPendingId(null)
      return result
    },
    [pending, setItemQuantity]
  )

  const dialog = pending ? (
    <QuantityDialog item={pending} onCancel={() => setPendingId(null)} onSubmit={submit} />
  ) : null

  return { request, dialog }
}
