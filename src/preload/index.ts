import { contextBridge, ipcRenderer } from 'electron'
import type { AppCommand, ShmooApi } from '../shared/types/api'

/**
 * 预加载脚本：只暴露白名单方法，不把 ipcRenderer 直接交给渲染进程。
 * 渲染进程通过 window.shmoo.xxx 调用，所有磁盘/对话框操作都在主进程完成。
 */
const api: ShmooApi = {
  openCsv: () => ipcRenderer.invoke('dialog:open-csv'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  savePng: (request) => ipcRenderer.invoke('export:save-png', request),
  savePdf: (request) => ipcRenderer.invoke('export:save-pdf', request),
  onCommand: (listener: (command: AppCommand) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AppCommand): void => listener(command)
    ipcRenderer.on('app:command', handler)
    // 返回取消订阅函数，供 React useEffect 清理，避免热更新后重复注册
    return () => {
      ipcRenderer.removeListener('app:command', handler)
    }
  }
}

contextBridge.exposeInMainWorld('shmoo', api)
