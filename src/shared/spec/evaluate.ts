import {
  CELL_FAIL,
  CELL_PASS,
  CELL_UNKNOWN,
  type CellEvaluation,
  type CellState,
  type SpecLimit
} from '../types/shmoo'

/**
 * spec 是否配置完整。
 * - window：min 与 max 都必须有
 * - min / max：对应的那一边必须有
 */
export function isSpecComplete(spec: SpecLimit): boolean {
  if (spec.mode === 'window') {
    return typeof spec.min === 'number' && typeof spec.max === 'number'
  }
  if (spec.mode === 'min') return typeof spec.min === 'number'
  return typeof spec.max === 'number'
}

/**
 * 单点三态判定（spec 推导）。
 * 无数据（NaN）永远返回 unknown，不能算失败 —— 这是整个工具的核心语义之一。
 */
export function evaluateCell(value: number, spec: SpecLimit): CellState {
  if (!Number.isFinite(value) || !isSpecComplete(spec)) return CELL_UNKNOWN

  if (spec.mode === 'max' && typeof spec.max === 'number') {
    return value <= spec.max ? CELL_PASS : CELL_FAIL
  }
  if (spec.mode === 'min' && typeof spec.min === 'number') {
    return value >= spec.min ? CELL_PASS : CELL_FAIL
  }
  if (typeof spec.min === 'number' && typeof spec.max === 'number') {
    return value >= spec.min && value <= spec.max ? CELL_PASS : CELL_FAIL
  }
  return CELL_UNKNOWN
}

/**
 * 计算 margin（到最近边界的距离，与测量值同单位，正值表示在规格内）。
 * 百分比口径：
 *  - 双边：margin / (max - min)
 *  - 单边：margin / |limit|，limit 为 0 时无法归一，返回 null
 */
export function evaluatePoint(value: number, spec: SpecLimit): CellEvaluation {
  const state = evaluateCell(value, spec)
  if (state === CELL_UNKNOWN) return { state, margin: null, marginPct: null }

  let margin: number | null = null
  let span: number | null = null

  if (spec.mode === 'window' && typeof spec.min === 'number' && typeof spec.max === 'number') {
    margin = Math.min(value - spec.min, spec.max - value)
    span = spec.max - spec.min
  } else if (spec.mode === 'max' && typeof spec.max === 'number') {
    margin = spec.max - value
    span = Math.abs(spec.max)
  } else if (spec.mode === 'min' && typeof spec.min === 'number') {
    margin = value - spec.min
    span = Math.abs(spec.min)
  }

  const marginPct = margin !== null && span !== null && span > 0 ? margin / span : null
  return { state, margin, marginPct }
}
