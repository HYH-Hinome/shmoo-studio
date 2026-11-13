/**
 * 导出相关的 IPC（阶段 ⑦）。
 *
 * 职责边界：
 *  - 渲染进程只负责“生成位图”（PNG）与“组装请求”（PDF）；
 *  - 主进程负责弹出保存对话框、生成矢量 PDF、写盘；
 *  - 记住上次导出目录（本次进程内 + 渲染进程 localStorage 双保险）。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  ExportPdfSaveRequest,
  ExportPngSaveRequest,
  ExportSaveResult
} from '../../shared/types/export'
import { buildPdfBuffer } from '../export/pdf'

/** 本次进程内记住的导出目录（下一次保存对话框默认打开这里） */
let lastExportDirectory: string | null = null

/** 嵌入字体缓存：只在第一次导出时读盘（约 2MB，子集化后写入 PDF） */
let fontBytesCache: Uint8Array | null = null

/** 字体文件位置：开发时在项目根，打包后在 asar 的 assets/fonts 下 */
function resolveFontPath(): string {
  return join(app.getAppPath(), 'assets', 'fonts', 'NotoSansSC-Subset.ttf')
}

/** 读取嵌入字体（Noto Sans SC 子集，OFL 1.1，允许嵌入分发） */
async function loadFontBytes(): Promise<Uint8Array> {
  if (fontBytesCache) return fontBytesCache
  fontBytesCache = new Uint8Array(await readFile(resolveFontPath()))
  return fontBytesCache
}

/**
 * 弹出保存对话框。
 * 渲染进程传来的是“文件名”而不是完整路径，这里统一用 basename 剥掉任何目录片段，
 * 防止被拼出应用目录之外的位置。
 */
async function pickSavePath(
  event: Electron.IpcMainInvokeEvent,
  defaultFileName: string,
  defaultDir: string | null,
  filterName: string,
  extension: 'png' | 'pdf'
): Promise<{ canceled: true } | { canceled: false; filePath: string }> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const dir = defaultDir || lastExportDirectory
  const safeName = basename(defaultFileName) || `export.${extension}`
  const options: Electron.SaveDialogOptions = {
    title: extension === 'png' ? '导出 PNG' : '导出 PDF',
    buttonLabel: '保存',
    defaultPath: dir ? join(dir, safeName) : safeName,
    filters: [{ name: filterName, extensions: [extension] }]
  }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { canceled: true }
  return { canceled: false, filePath: result.filePath }
}

/** 统一的保存结果包装：成功后记住目录，失败时返回可读错误 */
function success(filePath: string, bytes: number): ExportSaveResult {
  lastExportDirectory = dirname(filePath)
  return { canceled: false, filePath, directory: lastExportDirectory, bytes }
}

/** 注册导出 IPC；在 app ready 后调用一次 */
export function registerExportIpc(): void {
  ipcMain.handle(
    'export:save-png',
    async (event, request: ExportPngSaveRequest): Promise<ExportSaveResult> => {
      if (!request || !(request.data instanceof Uint8Array) || request.data.byteLength === 0) {
        return { canceled: false, error: 'PNG 数据为空' }
      }
      const picked = await pickSavePath(
        event,
        request.defaultFileName,
        request.defaultDir,
        'PNG 图片',
        'png'
      )
      if (picked.canceled) return { canceled: true }
      try {
        await writeFile(picked.filePath, Buffer.from(request.data))
        return success(picked.filePath, request.data.byteLength)
      } catch (err) {
        return {
          canceled: false,
          error: `写入 PNG 失败：${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  )

  ipcMain.handle(
    'export:save-pdf',
    async (event, payload: ExportPdfSaveRequest): Promise<ExportSaveResult> => {
      if (!payload?.request) return { canceled: false, error: 'PDF 请求为空' }
      const picked = await pickSavePath(
        event,
        payload.defaultFileName,
        payload.defaultDir,
        'PDF 文档',
        'pdf'
      )
      if (picked.canceled) return { canceled: true }
      try {
        const fontBytes = await loadFontBytes()
        const { bytes } = await buildPdfBuffer(payload.request, fontBytes)
        await writeFile(picked.filePath, bytes)
        return success(picked.filePath, bytes.byteLength)
      } catch (err) {
        return {
          canceled: false,
          error: `生成 PDF 失败：${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  )
}
