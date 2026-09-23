import { useCallback, useEffect, useRef, useState } from 'react'
import type { Item, RenameItemResult, StockRecord } from '@shared/types'
import { formatQuantity, normalizeName, roundQuantity } from '@shared/utils'

/**
 * 物品改名的交互层：可编辑的名称单元格 + 撞名合并的确认对话框。
 *
 * 仓库页和记录页都用这一份 —— 两页的改名语义完全相同（都是**改整个物品**，
 * 因为记录里的 name 只是这个物品的标签快照），各写一遍必然走样。
 */

// ── 右键菜单 ────────────────────────────────────────────────

function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: { label: string; onClick: () => void }[]
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    /*
     * 这里**必须用 pointerdown，不能用 click / contextmenu**，否则菜单会「闪一下就没」。
     *
     * 原因是 React 对离散事件（contextmenu 属于此类）会**同步 flush**，
     * 于是这个 effect 是在 contextmenu 还在往 window 冒泡的过程中就跑完的 ——
     * 此时新注册的 window 监听器会立刻收到**同一个** contextmenu 事件，
     * 刚挂上的菜单被自己打开的那一下关掉。
     * 表现极具迷惑性：菜单在 DOM 里出现过（MutationObserver 能记到），
     * 但任何轮询都抓不到，看起来像「右键没反应」。
     *
     * pointerdown 一定发生在 contextmenu **之前**，等这个 effect 跑完时它早就过去了，
     * 所以不存在「在途事件」。右键点别处也照样能关：pointerdown 先关掉旧菜单，
     * 紧接着的 contextmenu 再在新位置开一个。
     */
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    // 捕获阶段监听 scroll：菜单是 fixed 定位，不跟着页面滚，
    // 一滚就会停在半空中指向别处，不如直接关掉
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  return (
    <div
      className="ctx-menu"
      style={{ left: x, top: y }}
      role="menu"
      // 挡住冒泡，否则点菜单项时 window 上的 pointerdown 会先把菜单关掉
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => {
            onClose()
            it.onClick()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

// ── 行内编辑框 ──────────────────────────────────────────────

/**
 * 名称编辑框。
 *
 * 回车 / 失焦提交，Esc 取消。用 `done` 这个 ref 而不是 state 做「只提交一次」的闸门：
 * 回车会先触发提交、紧接着 blur 又触发一次，用 state 拦不住 ——
 * 同一个 tick 里两次 setState 都读到旧值，改名会被执行两遍。
 */
function NameInput({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (next: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(draft)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      type="text"
      className="name-input"
      value={draft}
      aria-label="物品名称"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}

// ── 名称单元格 ──────────────────────────────────────────────

export function NameCell({
  name,
  onRename
}: {
  name: string
  onRename: (next: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  if (editing) {
    return (
      <NameInput
        initial={name}
        onCommit={(next) => {
          // 先退出编辑态再提交：提交可能弹「合并确认」对话框，
          // 让编辑框一直开着的话，用户取消后会发现名字没变但框还在
          setEditing(false)
          onRename(next)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <>
      <span
        className="name-text"
        title="双击或右键修改名称"
        onDoubleClick={() => setEditing(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {name}
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{ label: '修改名称', onClick: () => setEditing(true) }]}
        />
      )}
    </>
  )
}

// ── 撞名合并的确认框 ────────────────────────────────────────

interface Pending {
  item: Item
  /** 归一化后的新名称（= 撞上的那个已有物品的名字） */
  name: string
  clash: Item
  recordCount: number
  /**
   * 界面在弹框时**自己算出来**的两边单位是否一致。
   *
   * 为什么不用数据层返回的 `unitConflict`：选单位这件事必须在**写盘之前**定下来，
   * 否则就得先写一次（已经合并了）再补一次改单位 —— 两次写之间进程挂掉就留下脏数据。
   * 所以界面只能拿自己手里的快照先判断。数据层那份 `unitConflict` 用来事后核对。
   */
  conflict: boolean
}

function MergeDialog({
  pending,
  onCancel,
  onConfirm
}: {
  pending: Pending
  onCancel: () => void
  onConfirm: (unit?: string) => void
}): React.JSX.Element {
  const { item, name, clash, recordCount, conflict } = pending
  const [unit, setUnit] = useState(clash.unit)
  const [custom, setCustom] = useState('')

  const effectiveUnit = custom.trim() || unit
  const merged = roundQuantity(clash.quantity + item.quantity)

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>合并到已有物品</h3>
          <button type="button" className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-text">
            已有物品「{name}」（{formatQuantity(clash.quantity)} {clash.unit}）。
            合并后共 <strong>{formatQuantity(merged)} {effectiveUnit}</strong>，
            「{item.name}」的 {recordCount} 条记录会转到「{name}」名下。
          </p>

          <p className="modal-note">
            合并不可撤销：之后「{item.name}」这个物品就不存在了。
          </p>

          {conflict && (
            <div className="unit-choice">
              <p className="unit-choice-title">
                两边单位不同（「{name}」是「{clash.unit}」，「{item.name}」是「{item.unit}」），
                合并后按哪个单位算？
              </p>
              <div className="unit-choice-btns">
                {[clash.unit, item.unit].map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={unit === u && !custom.trim() ? 'btn btn-sm btn-active' : 'btn btn-sm'}
                    onClick={() => {
                      setUnit(u)
                      setCustom('')
                    }}
                  >
                    {u}
                  </button>
                ))}
              </div>
              <input
                type="text"
                className="unit-choice-input"
                placeholder="或输入新单位…"
                value={custom}
                aria-label="合并后使用的单位"
                onChange={(e) => setCustom(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onConfirm(conflict ? effectiveUnit : undefined)}
          >
            合并
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 改名流程 ────────────────────────────────────────────────

export interface RenameFlow {
  /** 发起改名。撞名时会先弹合并确认框，其余情况直接改 */
  request: (item: Item, rawName: string) => void
  /** 需要时渲染的对话框（没在改名时是 null） */
  dialog: React.JSX.Element | null
}

/**
 * @param items   当前全部物品，用于判断新名字撞没撞上别的物品
 * @param records 当前全部记录，用于在确认框里告诉用户要搬走几条记录
 * @param renameItem 数据层的改名入口
 */
export function useRenameFlow(
  items: Item[],
  records: StockRecord[],
  renameItem: (id: string, name: string, unit?: string) => Promise<RenameItemResult>
): RenameFlow {
  const [pending, setPending] = useState<Pending | null>(null)

  const request = useCallback(
    (item: Item, rawName: string): void => {
      const name = normalizeName(rawName)
      if (!name) {
        // eslint-disable-next-line no-alert
        alert('名称不能为空')
        return
      }
      // 名字没变：静默结束。用户在编辑框里原样回车是正常操作
      if (name === item.name) return

      const clash = items.find((i) => i.name === name && i.id !== item.id)

      if (!clash) {
        void renameItem(item.id, name).then((r) => {
          if (!r.ok) {
            // eslint-disable-next-line no-alert
            alert(`改名失败：${r.error}`)
          }
        })
        return
      }

      setPending({
        item,
        name,
        clash,
        recordCount: records.filter((rec) => rec.itemId === item.id).length,
        conflict: item.unit !== clash.unit
      })
    },
    [items, records, renameItem]
  )

  const confirm = useCallback(
    (unit?: string): void => {
      if (!pending) return
      const { item, name, conflict } = pending
      setPending(null)
      void renameItem(item.id, name, unit).then((r) => {
        if (!r.ok) {
          // eslint-disable-next-line no-alert
          alert(`改名失败：${r.error}`)
          return
        }
        /*
         * 事后核对：数据层看到的单位冲突，和界面弹框时判断的不一致 ——
         * 说明界面手里那份快照已经过期（比如另一个窗口刚改过）。这时单位
         * 是按数据层默认值算的，必须让用户核对一眼，不能静默过去。
         */
        if (r.unitConflict && !conflict) {
          // eslint-disable-next-line no-alert
          alert(
            `注意：合并时两边单位其实不一致（${r.unitConflict.keptUnit} / ${r.unitConflict.otherUnit}），` +
              `已按「${r.item.unit}」计算库存，请核对。`
          )
          return
        }
        if (r.warning) {
          // eslint-disable-next-line no-alert
          alert(r.warning)
        }
      })
    },
    [pending, renameItem]
  )

  const dialog = pending ? (
    <MergeDialog pending={pending} onCancel={() => setPending(null)} onConfirm={confirm} />
  ) : null

  return { request, dialog }
}
