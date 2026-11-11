import { describe, expect, it } from 'vitest'
import {
  buildOneDSeries,
  computeValueScale,
  findPassRuns,
  nearestSampleIndex,
  niceTicks,
  pickPrimaryRun,
  valueToY
} from '@renderer/chart/oneD'
import type { ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'

/**
 * 1D Shmoo 纯逻辑测试（阶段 ④）：
 *  - PASS 区间的识别、断开规则、窗口宽度；
 *  - 主窗口选择；
 *  - 值域刻度包含 spec、覆盖数据、退化处理；
 *  - 值→像素映射方向、hover 吸附。
 */

const x = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]

describe('findPassRuns', () => {
  it('连续 PASS 合并成一段，边界取首末采样点', () => {
    const state = Uint8Array.from([CELL_FAIL, CELL_PASS, CELL_PASS, CELL_PASS, CELL_FAIL, CELL_FAIL, CELL_FAIL])
    const runs = findPassRuns(x, state)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ startIndex: 1, endIndex: 3, startX: 0.7, endX: 0.9 })
    expect(runs[0].width).toBeCloseTo(0.2, 10)
    expect(runs[0].count).toBe(3)
  })

  it('FAIL 会断开区间；多段按顺序返回', () => {
    const state = Uint8Array.from([CELL_PASS, CELL_PASS, CELL_FAIL, CELL_PASS, CELL_PASS, CELL_PASS, CELL_PASS])
    const runs = findPassRuns(x, state)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ startIndex: 0, endIndex: 1 })
    expect(runs[1]).toMatchObject({ startIndex: 3, endIndex: 6 })
  })

  it('UNKNOWN 不算 PASS，也会断开区间（缺失不能当成通过）', () => {
    const state = Uint8Array.from([CELL_PASS, CELL_UNKNOWN, CELL_PASS, CELL_PASS, CELL_FAIL, CELL_FAIL, CELL_FAIL])
    const runs = findPassRuns(x, state)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ startIndex: 0, endIndex: 0, width: 0 })
    expect(runs[1]).toMatchObject({ startIndex: 2, endIndex: 3 })
  })

  it('全 FAIL / 全 UNKNOWN 返回空数组', () => {
    expect(findPassRuns(x, Uint8Array.from([CELL_FAIL, CELL_FAIL]))).toEqual([])
    expect(findPassRuns(x, Uint8Array.from([CELL_UNKNOWN]))).toEqual([])
  })
})

describe('pickPrimaryRun', () => {
  it('选跨度最长的一段；跨度相同时选点数更多的一段', () => {
    const runs = [
      { startIndex: 0, endIndex: 1, startX: 0.6, endX: 0.7, width: 0.1, count: 2 },
      { startIndex: 3, endIndex: 6, startX: 0.9, endX: 1.2, width: 0.3, count: 4 },
      { startIndex: 7, endIndex: 8, startX: 1.3, endX: 1.4, width: 0.1, count: 2 }
    ]
    expect(pickPrimaryRun(runs)).toBe(runs[1])
    expect(pickPrimaryRun([])).toBeNull()
  })
})

describe('niceTicks', () => {
  it('步长落在 1 / 2 / 5 × 10^n 上，刻度在范围内且递增', () => {
    const ticks = niceTicks(0, 100, 6)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1])
    expect(ticks[0]).toBeGreaterThanOrEqual(0)
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(100)
  })

  it('小数范围不会产生浮点尾巴', () => {
    const ticks = niceTicks(0.6, 1.2, 5)
    for (const tick of ticks) {
      // 12 位有效数字后应当完全等于自身字符串表示，不含 0.30000000000000004
      expect(String(tick)).not.toMatch(/000000|999999/)
    }
  })
})

describe('computeValueScale', () => {
  const values = Float32Array.from([600, 700, 800, 900])

  it('覆盖数据范围并留出边距', () => {
    const scale = computeValueScale(values, { mode: 'min', min: 720 })
    expect(scale).not.toBeNull()
    expect(scale!.min).toBeLessThan(600)
    expect(scale!.max).toBeGreaterThan(900)
  })

  it('spec 上下限超出数据时也被纳入范围（否则 spec 线看不到）', () => {
    const scale = computeValueScale(values, { mode: 'window', min: 500, max: 1000 })
    expect(scale!.min).toBeLessThanOrEqual(500)
    expect(scale!.max).toBeGreaterThanOrEqual(1000)
  })

  it('忽略缺失值；全缺失返回 null', () => {
    const withNaN = Float32Array.from([Number.NaN, 700, Number.NaN, 800])
    const scale = computeValueScale(withNaN, { mode: 'min', min: 720 })
    expect(scale!.min).toBeLessThanOrEqual(700)
    expect(computeValueScale(Float32Array.from([Number.NaN, Number.NaN]), { mode: 'min' })).toBeNull()
  })

  it('单值退化时人为撑开范围，避免除零', () => {
    const scale = computeValueScale(Float32Array.from([800]), { mode: 'min' })
    expect(scale!.max).toBeGreaterThan(scale!.min)
    expect(scale!.ticks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('valueToY', () => {
  const scale = { min: 0, max: 100, ticks: [0, 50, 100] }

  it('值越大越靠上', () => {
    expect(valueToY(0, scale, 20, 200)).toBe(220)
    expect(valueToY(100, scale, 20, 200)).toBe(20)
    expect(valueToY(50, scale, 20, 200)).toBe(120)
  })
})

describe('nearestSampleIndex', () => {
  it('按像素位置吸附到最近的采样点', () => {
    // 绘图区 x = 100，宽 600，7 个点等距
    expect(nearestSampleIndex(x, 100, 100, 600)).toBe(0)
    expect(nearestSampleIndex(x, 700, 100, 600)).toBe(6)
    expect(nearestSampleIndex(x, 400, 100, 600)).toBe(3)
  })

  it('越界像素夹到首尾，单点数据集恒为 0', () => {
    expect(nearestSampleIndex(x, -50, 100, 600)).toBe(0)
    expect(nearestSampleIndex(x, 9999, 100, 600)).toBe(6)
    expect(nearestSampleIndex([0.8], 500, 100, 600)).toBe(0)
    expect(nearestSampleIndex([], 500, 100, 600)).toBe(-1)
  })
})

describe('buildOneDSeries', () => {
  const base = {
    xAxis: { key: 'x', label: 'VDD', unit: 'V', values: x, scale: 'linear' as const },
    yAxis: null,
    valueLabel: 'VOH',
    valueUnit: 'mV',
    spec: { mode: 'min' as const, min: 720 }
  }

  it('把 1D 数据集压平成序列', () => {
    const site = {
      siteId: '1',
      siteLabel: 'S',
      value: Float32Array.from(x.map(() => 800)),
      pass: Uint8Array.from(x.map(() => CELL_PASS)),
      valueRange: { min: 700, max: 900 },
      knownCount: x.length,
      passCount: x.length
    } as SiteGrid
    const dataset = { ...base, kind: '1d' } as unknown as ShmooDataset
    const series = buildOneDSeries(dataset, site)
    expect(series?.x).toHaveLength(7)
    expect(series?.value[0]).toBe(800)
    expect(series?.state[0]).toBe(CELL_PASS)
  })

  it('2D 数据集返回 null', () => {
    const site = { value: Float32Array.from([1]), pass: Uint8Array.from([CELL_PASS]) } as SiteGrid
    const dataset = { ...base, kind: '2d' } as unknown as ShmooDataset
    expect(buildOneDSeries(dataset, site)).toBeNull()
  })
})
