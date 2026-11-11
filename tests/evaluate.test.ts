import { describe, expect, it } from 'vitest'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'
import { evaluateCell, evaluatePoint, isSpecComplete } from '@shared/spec/evaluate'

/**
 * spec 判定与 margin 计算的单元测试。
 * 这些函数是 shmoo 图上色的唯一依据，边界（等于 min / 等于 max）必须明确。
 */

describe('isSpecComplete', () => {
  it('window 需要 min 与 max 同时存在', () => {
    expect(isSpecComplete({ mode: 'window', min: 1, max: 2 })).toBe(true)
    expect(isSpecComplete({ mode: 'window', min: 1 })).toBe(false)
  })

  it('单边模式只看对应的一边', () => {
    expect(isSpecComplete({ mode: 'min', min: 0 })).toBe(true)
    expect(isSpecComplete({ mode: 'min', max: 9 })).toBe(false)
    expect(isSpecComplete({ mode: 'max', max: 9 })).toBe(true)
  })
})

describe('evaluateCell', () => {
  it('无数据永远未知，即使 spec 完整', () => {
    expect(evaluateCell(Number.NaN, { mode: 'min', min: 720 })).toBe(CELL_UNKNOWN)
  })

  it('spec 不完整时一律未知，不能默认 fail', () => {
    expect(evaluateCell(700, { mode: 'min' })).toBe(CELL_UNKNOWN)
  })

  it('单边下限：等于边界算 pass，低于边界算 fail', () => {
    const spec = { mode: 'min' as const, min: 720 }
    expect(evaluateCell(720, spec)).toBe(CELL_PASS)
    expect(evaluateCell(719.999, spec)).toBe(CELL_FAIL)
  })

  it('单边上限：等于边界算 pass，高于边界算 fail', () => {
    const spec = { mode: 'max' as const, max: 860 }
    expect(evaluateCell(860, spec)).toBe(CELL_PASS)
    expect(evaluateCell(860.001, spec)).toBe(CELL_FAIL)
  })

  it('双边窗口：两端闭区间', () => {
    const spec = { mode: 'window' as const, min: 740, max: 860 }
    expect(evaluateCell(740, spec)).toBe(CELL_PASS)
    expect(evaluateCell(860, spec)).toBe(CELL_PASS)
    expect(evaluateCell(739.9, spec)).toBe(CELL_FAIL)
    expect(evaluateCell(860.1, spec)).toBe(CELL_FAIL)
  })
})

describe('evaluatePoint · margin', () => {
  it('单边下限：margin = value - min，百分比以 |min| 为分母', () => {
    const result = evaluatePoint(800, { mode: 'min', min: 720 })
    expect(result.margin).toBe(80)
    expect(result.marginPct).toBeCloseTo(80 / 720, 6)
  })

  it('双边窗口：margin 取到最近边界的距离，失败时为负', () => {
    expect(evaluatePoint(800, { mode: 'window', min: 740, max: 860 }).margin).toBe(60)
    expect(evaluatePoint(750, { mode: 'window', min: 740, max: 860 }).margin).toBe(10)
    expect(evaluatePoint(900, { mode: 'window', min: 740, max: 860 }).margin).toBe(-40)
  })

  it('未知点不产生 margin', () => {
    expect(evaluatePoint(Number.NaN, { mode: 'min', min: 720 })).toEqual({
      state: CELL_UNKNOWN,
      margin: null,
      marginPct: null
    })
  })
})
