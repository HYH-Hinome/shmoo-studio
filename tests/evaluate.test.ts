import { describe, expect, it } from 'vitest'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN, type ShmooDataset } from '@shared/types/shmoo'
import {
  evaluateCell,
  evaluatePoint,
  isHeatMeaningful,
  isMarginMeaningful,
  isSpecComplete,
  isZeroWidthWindow
} from '@shared/spec/evaluate'
import { parseShmooCsv } from '@shared/csv/parser'

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

  it('none 永远视为“没有可用 spec”', () => {
    expect(isSpecComplete({ mode: 'none' })).toBe(false)
  })

  it('min === max 的双边窗口是合法 spec', () => {
    expect(isSpecComplete({ mode: 'window', min: 1, max: 1 })).toBe(true)
    expect(isZeroWidthWindow({ mode: 'window', min: 1, max: 1 })).toBe(true)
    expect(isZeroWidthWindow({ mode: 'window', min: 1, max: 2 })).toBe(false)
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

  it('min === max：只有恰好等于该值才 pass（pattern 判定）', () => {
    const spec = { mode: 'window' as const, min: 1, max: 1 }
    expect(evaluateCell(1, spec)).toBe(CELL_PASS)
    expect(evaluateCell(0, spec)).toBe(CELL_FAIL)
    expect(evaluateCell(2, spec)).toBe(CELL_FAIL)
    expect(evaluateCell(0.999, spec)).toBe(CELL_FAIL)
  })

  it('spec 为 none 时一律未知', () => {
    expect(evaluateCell(800, { mode: 'none' })).toBe(CELL_UNKNOWN)
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
      marginPct: null,
      side: null
    })
  })

  it('双边 margin 记录来自哪一条边界（撞哪一边）', () => {
    const spec = { mode: 'window' as const, min: 740, max: 860 }
    // 靠近下限 → side = min
    expect(evaluatePoint(750, spec).side).toBe('min')
    // 靠近上限 → side = max
    expect(evaluatePoint(850, spec).side).toBe('max')
    // 越界时直接指向被越过的那一边
    expect(evaluatePoint(900, spec).side).toBe('max')
    expect(evaluatePoint(700, spec).side).toBe('min')
  })

  it('单边 margin 的 side 恒为对应边', () => {
    expect(evaluatePoint(800, { mode: 'min', min: 720 }).side).toBe('min')
    expect(evaluatePoint(800, { mode: 'max', max: 860 }).side).toBe('max')
  })

  it('零宽窗口无法归一化 marginPct，但 margin 仍然可用', () => {
    const result = evaluatePoint(1, { mode: 'window', min: 1, max: 1 })
    expect(result.margin).toBe(0)
    expect(result.marginPct).toBe(null)
  })
})

describe('数据形态判断（显示层降级）', () => {
  /**
   * 用真实解析链路构造一个最小 1D 数据集，
   * 避免手写 ShmooDataset 的十来个字段（也顺带覆盖了 parser 的 spec 传递）。
   */
  function makeDataset(values: number[], specLine: string): ShmooDataset {
    const csv = [
      '# kind: 1d',
      '# x_label: VDD',
      '# x_unit: V',
      '# value_label: V',
      `# spec: ${specLine}`,
      'x,site,value',
      ...values.map((value, i) => `${(0.6 + i * 0.1).toFixed(2)},1,${value}`)
    ].join('\n')
    const { dataset } = parseShmooCsv(csv, { fileName: 'test.csv' })
    return dataset as ShmooDataset
  }

  it('0/1 数据没有连续量，热力模式与 margin 都判为不适用', () => {
    const dataset = makeDataset([0, 1, 1, 0], 'min=1,max=1')
    expect(isHeatMeaningful(dataset)).toBe(false)
    expect(isMarginMeaningful(dataset)).toBe(false)
  })

  it('连续量数据仍可使用热力与 margin', () => {
    const dataset = makeDataset([700, 750, 800], 'min=720')
    expect(isHeatMeaningful(dataset)).toBe(true)
    expect(isMarginMeaningful(dataset)).toBe(true)
  })

  it('零宽窗口即使值域连续，margin 也标为不适用', () => {
    const dataset = makeDataset([1, 1.2, 0.8], 'min=1,max=1')
    expect(isHeatMeaningful(dataset)).toBe(true)
    expect(isMarginMeaningful(dataset)).toBe(false)
  })

  it('spec 为 none 时 margin 不适用', () => {
    const dataset = makeDataset([700, 750, 800], 'none')
    expect(isMarginMeaningful(dataset)).toBe(false)
  })

  it('pattern 样例解析后：二值域成立、通过区非空且不规则', () => {
    // 直接读样例文件的原始文本由 parser.test.ts 覆盖；这里只验证判定口径
    const csv = [
      '# kind: 1d',
      '# x_label: VDD',
      '# x_unit: V',
      '# value_label: BIST',
      '# spec: min=1,max=1',
      'x,site,value',
      '0.6,1,0',
      '0.7,1,1',
      '0.8,1,1',
      '0.9,1,0'
    ].join('\n')
    const { dataset } = parseShmooCsv(csv, { fileName: 'p.csv' })
    expect(dataset).not.toBeNull()
    expect(isHeatMeaningful(dataset as ShmooDataset)).toBe(false)
    expect(isMarginMeaningful(dataset as ShmooDataset)).toBe(false)
  })
})
