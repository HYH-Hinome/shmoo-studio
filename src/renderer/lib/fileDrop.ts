/**
 * 拖放导入的纯校验逻辑。
 *
 * 单独放在 lib 里而不是直接写进组件，原因：
 *  - 校验规则（扩展名、大小上限）可以被单元测试直接覆盖，不需要 DOM / File API；
 *  - 组件只负责接住 drag/drop 事件，store 只负责“校验通过后怎么载入”，职责清晰。
 */

/** 允许拖入的文件扩展名（大小写不敏感），与主进程文件对话框的过滤器保持一致 */
const CSV_EXTENSIONS = ['.csv', '.txt']

/** 单个文件大小上限：与主进程 dialog:open-csv 的 20MB 上限保持一致 */
export const DROP_MAX_BYTES = 20 * 1024 * 1024

/** 只依赖 File 的最小结构，方便测试时用普通对象代替真实的 File */
export interface DroppedFileLike {
  name: string
  size: number
}

/** 校验结果：成功时带回原对象（保留 File 的 text() 等方法），失败时带可直接展示的提示文案 */
export type DroppedCsvPick<T extends DroppedFileLike> =
  | { ok: true; file: T }
  | { ok: false; message: string }

/**
 * 从拖放的文件里挑出第一个可导入的 CSV。
 *
 * 规则（按顺序判断）：
 *  1. 没有文件 → 提示“没有检测到文件”（例如拖动的是文字 / 网页内容）；
 *  2. 扩展名不是 .csv / .txt → 明确告诉用户文件名和允许的格式；
 *  3. 超过 20MB → 与文件对话框一致的提示，避免大文件把内存打满。
 *
 * 注意：这里只做“能不能导入”的判断，真正的解析仍然交给 store 的统一流程，
 * 不会产生第二套解析逻辑。
 */
export function pickDroppedCsv<T extends DroppedFileLike>(
  files: ArrayLike<T> | null | undefined
): DroppedCsvPick<T> {
  if (!files || files.length === 0) {
    return { ok: false, message: '没有检测到文件：请把 CSV 文件拖到窗口内' }
  }

  const file = files[0]
  const name = file.name ?? ''
  const lowerName = name.toLowerCase()

  if (!CSV_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return {
      ok: false,
      message: `不支持的格式：${name || '未知文件'}（仅支持 .csv / .txt）`
    }
  }

  if (file.size > DROP_MAX_BYTES) {
    return {
      ok: false,
      message: `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），当前上限 20MB`
    }
  }

  return { ok: true, file }
}
