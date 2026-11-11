import { describe, expect, it } from 'vitest'
import {
  BINARY_COLORS,
  HEAT_STOPS,
  binaryColor,
  heatGradientStops,
  mixColor,
  sampleHeatColor,
  valueToT
} from '@renderer/chart/colors'

/**
 * 图表配色测试（阶段 ③）：
 *  - 二值模式色值必须与界面 token 一致；
 *  - 热力色带端点/夹紧/等值退化；
 *  - valueToT 对无范围、全等值、越界值的处理。
 */

describe('valueToT', () => {
  it('线性归一化', () => {
    expect(valueToT(5, { min: 0, max: 10 })).toBeCloseTo(0.5, 10)
    expect(valueToT(0, { min: 0, max: 10 })).toBe(0)
    expect(valueToT(10, { min: 0, max: 10 })).toBe(1)
  })

  it('越界值夹紧到 0–1', () => {
    expect(valueToT(-5, { min: 0, max: 10 })).toBe(0)
    expect(valueToT(99, { min: 0, max: 10 })).toBe(1)
  })

  it('无范围返回 0；min === max 退化为 0.5（单色）', () => {
    expect(valueToT(5, null)).toBe(0)
    expect(valueToT(3, { min: 2, max: 2 })).toBe(0.5)
  })

  it('NaN 不应产生 NaN 颜色位置', () => {
    expect(valueToT(Number.NaN, { min: 0, max: 1 })).toBe(0)
  })
})

describe('sampleHeatColor', () => {
  it('色带端点与停靠点精确对齐', () => {
    expect(sampleHeatColor(0)).toBe(HEAT_STOPS[0].color)
    expect(sampleHeatColor(0.34)).toBe('#1c6478')
    expect(sampleHeatColor(0.66)).toBe('#2fbf8f')
    expect(sampleHeatColor(1)).toBe('#d99a2b')
  })

  it('超出范围会被夹紧', () => {
    expect(sampleHeatColor(-1)).toBe(HEAT_STOPS[0].color)
    expect(sampleHeatColor(2)).toBe(HEAT_STOPS[HEAT_STOPS.length - 1].color)
  })

  it('中间取值为两停靠点之间的插值，不等于任一端点', () => {
    const middle = sampleHeatColor(0.5)
    expect(middle).not.toBe('#1c6478')
    expect(middle).not.toBe('#2fbf8f')
    expect(middle).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('NaN 回退到色带起点', () => {
    expect(sampleHeatColor(Number.NaN)).toBe(HEAT_STOPS[0].color)
  })
})

describe('heatGradientStops', () => {
  it('生成指定数量的取样色，首尾与色带端点一致', () => {
    const stops = heatGradientStops(5)
    expect(stops).toHaveLength(5)
    expect(stops[0]).toBe('#102b3f')
    expect(stops[4]).toBe('#d99a2b')
  })
})

describe('binaryColor', () => {
  it('三态映射：pass / fail / unknown', () => {
    expect(binaryColor(1)).toBe(BINARY_COLORS.pass)
    expect(binaryColor(0)).toBe(BINARY_COLORS.fail)
    expect(binaryColor(2)).toBe(BINARY_COLORS.unknownBase)
  })

  it('二值色与界面 token 同源（#2fbf8f / #e2555a）', () => {
    expect(BINARY_COLORS.pass).toBe('#2fbf8f')
    expect(BINARY_COLORS.fail).toBe('#e2555a')
  })
})

describe('mixColor', () => {
  it('0 / 1 返回原色，0.5 返回中点', () => {
    expect(mixColor('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixColor('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})
