import { useEffect } from 'react'

/**
 * 通用右键菜单。
 *
 * 从改名组件里抽出来共用：名称单元格（改名）和数量单元格（改数量）都要右键菜单，
 * 各写一份的话，下面那个「必须用 pointerdown」的坑会在其中一份里被重新踩一遍。
 */
export function ContextMenu({
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
