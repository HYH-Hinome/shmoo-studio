import type { ParseOptions, ParseResult } from '@shared/csv/parser'
import type { CsvWorkerRequest, CsvWorkerResponse } from '../workers/csv.worker'

/** 解析入参：来自主进程读取的 CSV 文本 */
export interface ParseCsvInput {
  text: string
  fileName: string
  filePath: string | null
  fileSize?: number
  options?: ParseOptions
}

let requestSeq = 0

/**
 * 在 Web Worker 中解析 CSV，主线程不卡顿。
 * 每次解析新建一个 Worker、完成后立即 terminate：
 *  - 优点：不存在残留状态，重复导入同一文件也不会串数据；
 *  - 代价：每次约几十毫秒启动开销，相对于解析本身可忽略。
 */
export function parseCsvInWorker(input: ParseCsvInput): Promise<ParseResult> {
  return new Promise<ParseResult>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/csv.worker.ts', import.meta.url), {
      type: 'module'
    })

    const requestId = ++requestSeq
    const request: CsvWorkerRequest = {
      requestId,
      text: input.text,
      fileName: input.fileName,
      filePath: input.filePath,
      fileSize: input.fileSize ?? input.text.length,
      options: input.options
    }

    const cleanup = (): void => {
      worker.terminate()
    }

    worker.onmessage = (event: MessageEvent<CsvWorkerResponse>) => {
      const response = event.data
      if (response.requestId !== requestId) return
      cleanup()
      if (response.ok) resolve(response.result)
      else reject(new Error(response.error))
    }

    worker.onerror = (event: ErrorEvent) => {
      cleanup()
      reject(new Error(event.message || 'CSV 解析 Worker 异常'))
    }

    worker.postMessage(request)
  })
}
