import { useCallback, useEffect, useState } from 'react'
import type { DB } from '@shared/types'

const EMPTY_DB: DB = { version: 1, items: [], records: [] }

export interface AppData {
  db: DB
  ready: boolean
  error: string
  refresh: () => Promise<void>
}

/**
 * 订阅主进程的数据快照。
 *
 * 三个页面共用这一份数据源：任一入口提交出入库后主进程会广播 `db:changed`，
 * 这里收到就重新拉取，于是「一处操作、所有页面更新」自动成立。
 */
export function useAppData(): AppData {
  const [db, setDb] = useState<DB>(EMPTY_DB)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const snapshot = await window.api.getSnapshot()
    setDb(snapshot)
  }, [])

  useEffect(() => {
    let cancelled = false
    let subId: number | undefined

    const boot = async (): Promise<void> => {
      try {
        await refresh()
      } catch (err) {
        // 非 Electron 环境（例如在浏览器里做界面验证）会走到这里
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setReady(true)
      }

      try {
        subId = window.api.onChanged(() => {
          void refresh()
        })
      } catch {
        /* 非 Electron 环境，忽略 */
      }
    }

    void boot()

    return () => {
      cancelled = true
      if (subId !== undefined) {
        try {
          window.api.offChanged(subId)
        } catch {
          /* 忽略 */
        }
      }
    }
  }, [refresh])

  return { db, ready, error, refresh }
}
