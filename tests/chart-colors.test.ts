import { describe, expect, it } from 'vitest'
import {
  BINARY_PALETTE,
  HEAT_STOPS,
  binaryMarginColor,
  binarySwatchStops,
  computeMarginTints,
  heatGradientStops,
  mixColor,
  passFailColor,
  sampleHeatColor,
  valueToT
} from '@renderer/chart/colors'
import type { SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'

/**
 * 图表配色测试（阶段 ③c 定稿：A′ 单一色板）：
 *  - 热力色带端点/夹紧/等值退化；
 *  - valueToT 对无范围、全等值、越界值的处理；
 *  - 二值 PASS 青绿 / FAIL 正红 + margin 明度调制；
 *  - margin 归一化（p90 参考值、缺失格不参与）。
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
    // 热力暖端保持琥珀：这是“数值高低”的编码，不能跟着 FAIL 变红
    expect(stops[4]).toBe('#d99a2b')
  })
})

describe('binaryMarginColor（A′：margin 明度调制 + 正红 FAIL）', () => {
  it('m = 0 时为暗端（锚点混入 30%），m = 1 时为完整锚点', () => {
    expect(binaryMarginColor(CELL_PASS, 0)).toBe(
      mixColor(BINARY_PALETTE.passShadow, BINARY_PALETTE.passAnchor, 0.3)
    )
    expect(binaryMarginColor(CELL_PASS, 1)).toBe(BINARY_PALETTE.passAnchor)
    expect(binaryMarginColor(CELL_FAIL, 0)).toBe(
      mixColor(BINARY_PALETTE.failShadow, BINARY_PALETTE.failAnchor, 0.3)
    )
    expect(binaryMarginColor(CELL_FAIL, 1)).toBe(BINARY_PALETTE.failAnchor)
  })

  it('明度随 |margin| 单调递增（同色相内越远越亮）', () => {
    const luma = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16)
      return ((n >> 16) & 0xff) * 0.2126 + ((n >> 8) & 0xff) * 0.7152 + (n & 0xff) * 0.0722
    }
    const samples = [0, 0.25, 0.5, 0.75, 1].map((m) => luma(binaryMarginColor(CELL_PASS, m)))
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1])
    }
  })

  it('PASS 青绿 / FAIL 正红，端点色值固定', () => {
    expect(binaryMarginColor(CELL_PASS, 1)).toBe('#3d8b80')
    expect(binaryMarginColor(CELL_FAIL, 1)).toBe('#b5564f')
  })

  it('FAIL 暗端为同色相压暗，仍偏红（不偏灰/偏黄）', () => {
    const dark = binaryMarginColor(CELL_FAIL, 0)
    const n = Number.parseInt(dark.slice(1), 16)
    const r = (n >> 16) & 0xff
    const g = (n >> 8) & 0xff
    const b = n & 0xff
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    expect(g - b).toBeLessThan(10)
  })

  it('m 越界或 NaN 时夹紧，不产生非法颜色', () => {
    expect(binaryMarginColor(CELL_PASS, -3)).toBe(binaryMarginColor(CELL_PASS, 0))
    expect(binaryMarginColor(CELL_PASS, 9)).toBe(binaryMarginColor(CELL_PASS, 1))
    expect(binaryMarginColor(CELL_PASS, Number.NaN)).toBe(binaryMarginColor(CELL_PASS, 0))
  })

  it('未知格恒为 unknownBase，与 m 无关', () => {
    expect(binaryMarginColor(CELL_UNKNOWN, 0)).toBe(BINARY_PALETTE.unknownBase)
    expect(binaryMarginColor(CELL_UNKNOWN, 1)).toBe(BINARY_PALETTE.unknownBase)
  })
})

describe('passFailColor（纯二值数据：饱和平涂，不做明度调制）', () => {
  it('PASS = #34C759，FAIL = #FF3B30，未知格回到缺测底色', () => {
    expect(passFailColor(CELL_PASS)).toBe('#34C759')
    expect(passFailColor(CELL_FAIL)).toBe('#FF3B30')
    expect(passFailColor(CELL_UNKNOWN)).toBe(BINARY_PALETTE.unknownBase)
  })

  it('30×30 = 900 格里同状态颜色完全一致（只有 2 种颜色）', () => {
    const colors = new Set<string>()
    for (let i = 0; i < 900; i++) colors.add(passFailColor(i % 2))
    expect(colors.size).toBe(2)
    expect(colors.has('#34C759')).toBe(true)
    expect(colors.has('#FF3B30')).toBe(true)
  })
})

describe('binarySwatchStops', () => {
  it('色卡从暗端渐变到锚点，且首尾与主图同源', () => {
    const stops = binarySwatchStops(CELL_PASS, 4)
    expect(stops).toHaveLength(4)
    expect(stops[0]).toBe(binaryMarginColor(CELL_PASS, 0))
    expect(stops[3]).toBe(binaryMarginColor(CELL_PASS, 1))
  })
})

describe('computeMarginTints', () => {
  const makeSite = (values: number[], pass: number[]): SiteGrid => ({
    siteId: 'S',
    siteLabel: 'S',
    value: Float32Array.from(values),
    pass: Uint8Array.from(pass),
    valueRange: { min: Math.min(...values), max: Math.max(...values) },
    knownCount: values.length,
    passCount: pass.filter((p) => p === CELL_PASS).length
  })

  it('按 p90 归一化：贴住 spec 的格子最暗，远离的按比例变亮', () => {
    // min spec = 100；marginPct 分别 0 / 0.1 / 0.2 / 0.5 → |marginPct| 的 p90 = 0.5
    const values = [100, 110, 120, 150]
    const tints = computeMarginTints(makeSite(values, [CELL_PASS, CELL_PASS, CELL_PASS, CELL_PASS]), {
      mode: 'min',
      min: 100
    })
    expect(tints).not.toBeNull()
    expect(tints?.[0]).toBeCloseTo(0, 6)
    expect(tints?.[1]).toBeCloseTo(0.2, 6)
    expect(tints?.[2]).toBeCloseTo(0.4, 6)
    expect(tints?.[3]).toBeCloseTo(1, 6)
  })

  it('失效格的 |margin| 同样参与归一化（取绝对值）', () => {
    const tints = computeMarginTints(makeSite([80, 100], [CELL_FAIL, CELL_PASS]), {
      mode: 'min',
      min: 100
    })
    // marginPct：-0.2 / 0 → p90 = 0.2 → 失效格为 1
    expect(tints?.[0]).toBeCloseTo(1, 6)
    expect(tints?.[1]).toBeCloseTo(0, 6)
  })

  it('缺失格不参与统计（保持 0）；spec 不完整时返回 null', () => {
    const tints = computeMarginTints(
      makeSite([100, 120, Number.NaN], [CELL_PASS, CELL_PASS, CELL_UNKNOWN]),
      { mode: 'min', min: 100 }
    )
    expect(tints?.[2]).toBe(0)
    expect(computeMarginTints(makeSite([1, 2], [CELL_PASS, CELL_PASS]), { mode: 'min' })).toBeNull()
  })

  it('所有 margin 相同（p90 = 0）时统一为 1，退化成纯色', () => {
    const tints = computeMarginTints(makeSite([100, 100], [CELL_PASS, CELL_PASS]), {
      mode: 'min',
      min: 100
    })
    expect(tints?.[0]).toBe(1)
    expect(tints?.[1]).toBe(1)
  })
})

describe('mixColor', () => {
  it('0 / 1 返回原色，0.5 返回中点', () => {
    expect(mixColor('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixColor('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})
