import { parseShmooCsv, type ParseOptions, type ParseResult } from '@shared/csv/parser'

/**
 * CSV 解析 Worker。
 * 放在渲染进程内（不是主进程）：解析结果直接是界面要用的结构，省掉一次 IPC 拷贝；
 * 同时不阻塞 UI 线程（Electron 官方推荐把重计算放到 Web Worker）。
 */

export interface CsvWorkerRequest {
  /** 请求 id，用于校验响应对应关系 */
  requestId: number
  text: string
  fileName: string
  filePath: string | null
  fileSize: number
  options?: ParseOptions
}

export type CsvWorkerResponse =
  | { requestId: number; ok: true; result: ParseResult }
  | { requestId: number; ok: false; error: string }

// Worker 全局作用域：TypeScript 在 DOM lib 下通过 self 访问
self.onmessage = (event: MessageEvent<CsvWorkerRequest>) => {
  const { requestId, text, fileName, filePath, fileSize, options } = event.data
  try {
    const startedAt = performance.now()
    const result = parseShmooCsv(text, { fileName, filePath, fileSize }, options)
    // 用 Worker 内部计时覆盖，避免把消息往返时间算进解析耗时
    result.report.parseMs = Math.round((performance.now() - startedAt) * 100) / 100
    const response: CsvWorkerResponse = { requestId, ok: true, result }
    self.postMessage(response)
  } catch (error) {
    const response: CsvWorkerResponse = {
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
