/**
 * 阶段 ⑥：规格面板输入解析与校验。
 *
 * 放在 shared 层便于单测，也保证界面与「重新解析 CSV」使用同一套数值口径。
 * 规则（与用户需求一致）：
 *  - 两边都填：双边窗口，允许 min === max（pattern 场景）；
 *  - 只填下限 / 只填上限：单边；
 *  - 两边都空、非数字、min > max：拒绝应用并给出明确原因，绝不静默改成默认值。
 */

import type { SpecLimit } from '../types/shmoo'

/** 输入解析结果：ok=false 时 error 一定存在 */
export interface SpecInputResult {
  ok: boolean
  spec?: SpecLimit
  error?: string
}

/**
 * 数字格式：允许正负号、小数、科学计数法，但拒绝空串、NaN、Infinity 等。
 * 不用 Number() 直接判定，是为了拒绝 "0x10"、"1e"、"" 这类隐式转换陷阱。
 */
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** 解析单边输入；空串返回 undefined，非法返回错误字符串 */
function parseSide(text: string, label: string): { value?: number; error?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  if (!NUMBER_PATTERN.test(trimmed)) return { error: `${label}必须是数字` }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { error: `${label}必须是有限数字` }
  return { value }
}

/**
 * 把两个输入框的文本解析成 spec。
 * @param minText 下限输入原文
 * @param maxText 上限输入原文
 */
export function parseSpecInput(minText: string, maxText: string): SpecInputResult {
  const minResult = parseSide(minText, '下限')
  if (minResult.error) return { ok: false, error: minResult.error }

  const maxResult = parseSide(maxText, '上限')
  if (maxResult.error) return { ok: false, error: maxResult.error }

  const hasMin = typeof minResult.value === 'number'
  const hasMax = typeof maxResult.value === 'number'

  if (!hasMin && !hasMax) {
    return { ok: false, error: '请至少填写下限或上限' }
  }
  if (hasMin && hasMax && (minResult.value as number) > (maxResult.value as number)) {
    return { ok: false, error: '下限不能大于上限' }
  }

  if (hasMin && hasMax) {
    return { ok: true, spec: { mode: 'window', min: minResult.value, max: maxResult.value } }
  }
  if (hasMin) return { ok: true, spec: { mode: 'min', min: minResult.value } }
  return { ok: true, spec: { mode: 'max', max: maxResult.value } }
}

/** 把数值转成输入框文本：undefined → 空串，避免展示 "undefined" */
export function specValueToText(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : ''
}

/** 当前 spec 对应的模式名（用于面板里只读展示） */
export function specModeLabel(spec: SpecLimit): string {
  if (spec.mode === 'none') return '不判定'
  if (spec.mode === 'min') return '只设下限'
  if (spec.mode === 'max') return '只设上限'
  if (typeof spec.min === 'number' && typeof spec.max === 'number' && spec.min === spec.max) {
    return '单点窗口'
  }
  return '双边窗口'
}
