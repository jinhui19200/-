import { useCallback, useEffect, useState } from 'react'
import type {
  DB,
  DeleteRecordResult,
  RenameItemResult,
  SetQuantityResult,
  SetThresholdResult,
  TransactionInput,
  TransactionResult
} from '@shared/types'

const EMPTY_DB: DB = { version: 1, items: [], records: [] }

export interface AppData {
  db: DB
  ready: boolean
  error: string
  /** 本次启动是否发生过「从备份恢复」（界面需要提示用户） */
  recoveredFromBackup: boolean
  /** 数据文件完整路径，用于界面展示 */
  dataPath: string
  refresh: () => Promise<void>
  applyTransaction: (input: TransactionInput) => Promise<TransactionResult>
  deleteRecord: (id: string) => Promise<DeleteRecordResult>
  setItemThreshold: (id: string, threshold: number) => Promise<SetThresholdResult>
  /** 强行修改库存数量（需口令，校验在数据层） */
  setItemQuantity: (id: string, quantity: number, password: string) => Promise<SetQuantityResult>
  renameItem: (id: string, name: string, unit?: string) => Promise<RenameItemResult>
  exportXlsx: (data: number[], defaultName: string) => Promise<{
    ok: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }>
  openDataFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>
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
  const [recoveredFromBackup, setRecoveredFromBackup] = useState(false)
  const [dataPath, setDataPath] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const snapshot = await window.api.getSnapshot()
    setDb(snapshot)
  }, [])

  const applyTransaction = useCallback(
    async (input: TransactionInput): Promise<TransactionResult> => {
      const result = await window.api.applyTransaction(input)
      if (result.ok) await refresh()
      return result
    },
    [refresh]
  )

  const deleteRecord = useCallback(
    async (id: string): Promise<DeleteRecordResult> => {
      const result = await window.api.deleteRecord(id)
      if (result.ok) await refresh()
      return result
    },
    [refresh]
  )

  const setItemThreshold = useCallback(
    async (id: string, threshold: number): Promise<SetThresholdResult> => {
      const result = await window.api.setItemThreshold(id, threshold)
      if (result.ok) await refresh()
      return result
    },
    [refresh]
  )

  const setItemQuantity = useCallback(
    async (id: string, quantity: number, password: string): Promise<SetQuantityResult> => {
      const result = await window.api.setItemQuantity(id, quantity, password)
      if (result.ok) await refresh()
      return result
    },
    [refresh]
  )

  const exportXlsx = useCallback(async (data: number[], defaultName: string) => {
    return window.api.exportXlsx(data, defaultName)
  }, [])
  const renameItem = useCallback(
    async (id: string, name: string, unit?: string): Promise<RenameItemResult> => {
      const result = await window.api.renameItem(id, name, unit)
      if (result.ok) await refresh()
      return result
    },
    [refresh]
  )
  const openDataFolder = useCallback(async () => {
    return window.api.openDataFolder()
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

      // 这两项是「锦上添花」的信息，拿不到也不该影响主流程
      try {
        const report = await window.api.getLoadReport()
        if (!cancelled) setRecoveredFromBackup(report.recoveredFromBackup)
      } catch {
        /* 忽略 */
      }
      try {
        const p = await window.api.getDataPath()
        if (!cancelled) setDataPath(p)
      } catch {
        /* 忽略 */
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

  return {
    db,
    ready,
    error,
    recoveredFromBackup,
    dataPath,
    refresh,
    applyTransaction,
    deleteRecord,
    setItemThreshold,
    setItemQuantity,
    renameItem,
    exportXlsx,
    openDataFolder
  }
}
