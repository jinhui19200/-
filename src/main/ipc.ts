import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { TransactionInput } from '@shared/types'
import { getSnapshot } from './store/db'
import { applyTransaction, deleteRecord } from './store/transactions'

/**
 * 数据变更后广播给所有窗口。
 * 三个页面都订阅这个事件，因此「任一入口提交 → 所有页面更新」是天然成立的，
 * 不需要任何一处手动去刷新另一处。
 */
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('db:changed')
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('app:ping', () => 'pong')

  /** 读取当前快照（纯内存，不碰磁盘） */
  ipcMain.handle('db:snapshot', () => getSnapshot())

  /** 出库 / 入库 —— 三个页面共用这一个通道 */
  ipcMain.handle('db:transaction', async (_event, input: TransactionInput) => {
    const result = await applyTransaction(input)
    if (result.ok) broadcastChanged()
    return result
  })

  /** 撤销记录（会反向冲销库存） */
  ipcMain.handle('db:deleteRecord', async (_event, id: string) => {
    const result = await deleteRecord(id)
    if (result.ok) broadcastChanged()
    return result
  })

  /** 导出 Excel：渲染进程生成 buffer，主进程弹 dialog 保存 */
  ipcMain.handle('export:xlsx', async (_event, data: number[], defaultName: string) => {
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (!filePath) return { ok: false, cancelled: true }
    try {
      await writeFile(filePath, Buffer.from(data))
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
}
