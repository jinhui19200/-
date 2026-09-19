import { ipcMain } from 'electron'

/**
 * 注册所有主进程 IPC 处理器。
 * P2 阶段会在这里接入数据层（getSnapshot / applyTransaction / deleteRecord / exportRecords）。
 */
export function registerIpcHandlers(): void {
  ipcMain.handle('app:ping', () => 'pong')
}
