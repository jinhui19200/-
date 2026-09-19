import { app, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { initStore, load } from './store/db'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: '库存管理系统',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例锁：防止多开导致两个进程同时写同一个数据文件
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.jinhui.warehouse-manager')

    // 先定位数据文件并加载完成，再开窗口 —— 保证渲染进程一启动就能拿到数据，
    // 不会出现「界面已渲染、数据还没到位」的空窗期
    initStore(app.getPath('userData'))

    try {
      await load()
    } catch (err) {
      // 主文件与备份都读不了 —— 把原因和路径原样告诉用户，然后退出。
      // 绝不能默默当成空库继续：那样用户一操作就会把仅存的数据覆盖掉。
      dialog.showErrorBox(
        '数据文件无法读取',
        `${err instanceof Error ? err.message : String(err)}\n\n` +
          '程序将退出。请先备份数据目录，再处理损坏的文件。'
      )
      app.quit()
      return
    }

    registerIpcHandlers()

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
