import type { CellState, ImportIssue, IssueLevel } from '../types/shmoo'

/**
 * 容错规则的错误码，与执行计划 3.6 节一一对应。
 * 测试用例直接断言这些 code，避免文案改动导致测试失效。
 */
export const ISSUE_CODES = {
  /** R2：文件版本高于当前支持版本 */
  FILE_VERSION: 'R2',
  /** R5：表头存在未知列 */
  UNKNOWN_COLUMN: 'R5',
  /** R6：x / y / value 非数值 */
  BAD_NUMBER: 'R6',
  /** R7：pass 值无法识别 */
  BAD_PASS_TOKEN: 'R7',
  /** R8：同一 (x, y, site) 重复 */
  DUPLICATE_POINT: 'R8',
  /** R12：site 数超过提示阈值 */
  MANY_SITES: 'R12',
  /** R13：行数超过提示阈值 */
  LARGE_FILE: 'R13',
  /** R14：疑似非 UTF-8 编码 */
  ENCODING: 'R14',
  /** R16：derived 模式但没有 spec */
  NO_SPEC: 'R16',
  /** R17：列数与表头不一致 */
  COLUMN_MISMATCH: 'R17',
  /** spec 元数据格式非法 */
  BAD_SPEC: 'SPEC',
  /** E100：2D 缺少 y 列 */
  MISSING_Y: 'E100',
  /** E101：缺少 x 列 */
  MISSING_X: 'E101',
  /** E102：没有有效数据行 */
  NO_DATA: 'E102',
  /** E103：measured 类型但 value 全空 */
  EMPTY_VALUE: 'E103',
  /** E104：声明为 1D，但 y 列存在多个取值 */
  INCONSISTENT_1D: 'E104',
  /** E105：表头不可解析（没有找到表头） */
  NO_HEADER: 'E105'
} as const

export type IssueCode = (typeof ISSUE_CODES)[keyof typeof ISSUE_CODES]

/**
 * 问题收集器：
 * 逐行解析时可能产生成千上万条同类警告，这里按 code 聚合，
 * 只保留首条明细与前 5 个行号，其余用 count 计数，避免 UI 被刷屏。
 */
export class IssueCollector {
  private readonly buckets = new Map<
    string,
    { level: IssueLevel; message: string; count: number; lines: number[] }
  >()

  add(level: IssueLevel, code: string, message: string, line?: number, repeat = 1): void {
    const existing = this.buckets.get(code)
    if (existing) {
      existing.count += repeat
      if (line !== undefined && existing.lines.length < 5 && !existing.lines.includes(line)) {
        existing.lines.push(line)
      }
      return
    }
    this.buckets.set(code, {
      level,
      message,
      count: repeat,
      lines: line !== undefined ? [line] : []
    })
  }

  has(code: string): boolean {
    return this.buckets.has(code)
  }

  hasError(): boolean {
    for (const bucket of this.buckets.values()) {
      if (bucket.level === 'error') return true
    }
    return false
  }

  all(): ImportIssue[] {
    const result: ImportIssue[] = []
    for (const [code, bucket] of this.buckets) {
      const lineHint = bucket.lines.length > 0 ? `（行 ${bucket.lines.join(', ')}）` : ''
      result.push({
        level: bucket.level,
        code,
        message: `${bucket.message}${lineHint}`,
        line: bucket.lines[0],
        count: bucket.count
      })
    }
    return result
  }
}

/** 表头 / 列名归一化：去空格、转小写 */
export function normalizeColumnName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * 刻度值归一：统一保留 12 位有效数字。
 * 目的：避免 0.1+0.2 之类的浮点表示差异，把同一刻度拆成两列。
 */
export function normalizeTick(value: number): number {
  const rounded = Number(value.toPrecision(12))
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * pass 列取值解析。
 * 合法：1 / 0 / true / false / pass / fail（大小写不敏感）
 * 空字符串与无法识别的值都返回 null（= 未知），由调用方决定是否记 R7。
 */
export function parsePassToken(raw: string): CellState | null {
  const token = raw.trim().toLowerCase()
  if (token === '') return null
  if (token === '1' || token === 'true' || token === 'pass') return 1
  if (token === '0' || token === 'false' || token === 'fail') return 0
  return null
}

/** 数值解析：空串与非法值都返回 NaN（非法值由调用方记 R6） */
export function parseNumeric(raw: string): number {
  if (raw.trim() === '') return Number.NaN
  const value = Number(raw)
  return Number.isFinite(value) ? normalizeTick(value) : Number.NaN
}
