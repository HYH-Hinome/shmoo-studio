/**
 * 主进程 ↔ 渲染进程的 IPC 契约类型。
 * 渲染进程只能通过 preload 暴露的 window.shmoo 访问这些能力，禁止直接使用 fs / path。
 */

import type { ExportPdfSaveRequest, ExportPngSaveRequest, ExportSaveResult } from './export'

/** 由菜单或快捷键派发到渲染进程的命令 */
export type AppCommand = 'open-csv' | 'export-png' | 'export-pdf'

/** 打开 CSV 后返回给渲染进程的内容（阶段 ① 只做读取，解析在阶段 ② 的 Worker 中完成） */
export interface OpenedCsvFile {
  path: string
  name: string
  /** UTF-8 文本内容 */
  text: string
}

export interface AppInfo {
  version: string
  platform: string
}

/** preload 通过 contextBridge 暴露到 window.shmoo 的白名单 API */
export interface ShmooApi {
  /** 弹出系统文件对话框并读取 CSV 文本；用户取消时返回 null */
  openCsv(): Promise<OpenedCsvFile | null>
  getAppInfo(): Promise<AppInfo>
  /** 保存 PNG 位图（渲染进程已生成字节，主进程只弹框+落盘） */
  savePng(request: ExportPngSaveRequest): Promise<ExportSaveResult>
  /** 生成并保存矢量 PDF（主进程用 pdfkit + 嵌入字体） */
  savePdf(request: ExportPdfSaveRequest): Promise<ExportSaveResult>
  /** 订阅主进程菜单命令，返回取消订阅函数 */
  onCommand(listener: (command: AppCommand) => void): () => void
}
