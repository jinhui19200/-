import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 暴露给渲染进程的 API。
// P2 阶段会在这里补上数据层的调用（applyTransaction / deleteRecord / getSnapshot 等）。
const api = {
  /** 连通性自检：确认主进程与渲染进程之间的通道正常 */
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping')
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore 类型定义见 index.d.ts
  window.electron = electronAPI
  // @ts-ignore 类型定义见 index.d.ts
  window.api = api
}
