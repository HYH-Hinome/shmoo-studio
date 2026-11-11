import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AppInfo, OpenedCsvFile } from '../../shared/types/api'

/** 单个 CSV 的大小上限：20MB 足够覆盖 50 万行长表，防止误选大文件把内存打满 */
const MAX_CSV_BYTES = 20 * 1024 * 1024

/**
 * 注册与“文件读取”相关的 IPC。
 * 渲染进程不允许直接触碰文件系统，所有磁盘操作都收敛在主进程。
 */
export function registerFileIpc(): void {
  ipcMain.handle('dialog:open-csv', async (event): Promise<OpenedCsvFile | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)

    const options: Electron.OpenDialogOptions = {
      title: '导入 Shmoo CSV',
      buttonLabel: '导入',
      properties: ['openFile'],
      filters: [
        { name: 'Shmoo CSV', extensions: ['csv', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    // 有父窗口时挂成模态对话框，避免文件框被主窗口遮挡
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    const info = await stat(filePath)
    if (info.size > MAX_CSV_BYTES) {
      throw new Error(`文件过大（${(info.size / 1024 / 1024).toFixed(1)}MB），当前上限 20MB`)
    }

    // 统一按 UTF-8 读取；GBK 文件的识别与重读放在阶段 ② 的解析器里处理
    const text = await readFile(filePath, 'utf8')

    return { path: filePath, name: basename(filePath), text }
  })

  ipcMain.handle('app:info', (): AppInfo => {
    return { version: app.getVersion(), platform: process.platform }
  })
}
