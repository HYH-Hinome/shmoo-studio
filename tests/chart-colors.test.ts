import { describe, expect, it } from 'vitest'
import {
  BINARY_PALETTES,
  HEAT_STOPS,
  HEAT_STOPS_MUTED,
  binaryMarginColor,
  binarySwatchStops,
  computeMarginTints,
  heatGradientStops,
  mixColor,
  sampleHeatColor,
  valueToT
} from '@renderer/chart/colors'
import type { SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'

/**
 * 图表配色测试（阶段 ③ / ③b）：
 *  - 热力色带端点/夹紧/等值退化；
 *  - valueToT 对无范围、全等值、越界值的处理；
 *  - 二值 A 版的 margin 明度调制公式与 B 版的平坦填充；
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
    expect(stops[4]).toBe('#d99a2b')
  })

  it('B 版使用降饱和色带，端点与 A 版不同', () => {
    expect(heatGradientStops(5, 'B')[0]).toBe(HEAT_STOPS_MUTED[0].color)
    expect(heatGradientStops(5, 'B')[4]).toBe(HEAT_STOPS_MUTED[HEAT_STOPS_MUTED.length - 1].color)
    expect(heatGradientStops(5, 'B')[4]).not.toBe('#d99a2b')
  })
})

describe('binaryMarginColor（A 版：margin 明度调制）', () => {
  it('m = 0 时为暗端（锚点混入 30%），m = 1 时为完整锚点', () => {
    const palette = BINARY_PALETTES.A
    expect(binaryMarginColor('A', CELL_PASS, 0)).toBe(
      mixColor(palette.passShadow, palette.passAnchor, 0.3)
    )
    expect(binaryMarginColor('A', CELL_PASS, 1)).toBe(palette.passAnchor)
    expect(binaryMarginColor('A', CELL_FAIL, 0)).toBe(
      mixColor(palette.failShadow, palette.failAnchor, 0.3)
    )
    expect(binaryMarginColor('A', CELL_FAIL, 1)).toBe(palette.failAnchor)
  })

  it('明度随 |margin| 单调递增（同色相内越远越亮）', () => {
    const luma = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16)
      return ((n >> 16) & 0xff) * 0.2126 + ((n >> 8) & 0xff) * 0.7152 + (n & 0xff) * 0.0722
    }
    const samples = [0, 0.25, 0.5, 0.75, 1].map((m) => luma(binaryMarginColor('A', CELL_PASS, m)))
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1])
    }
  })

  it('PASS 与 FAIL 色相不同（分别取色带的青绿与琥珀）', () => {
    expect(binaryMarginColor('A', CELL_PASS, 1)).toBe('#26968a')
    expect(binaryMarginColor('A', CELL_FAIL, 1)).toBe('#d99a2b')
  })

  it('m 越界或 NaN 时夹紧，不产生非法颜色', () => {
    expect(binaryMarginColor('A', CELL_PASS, -3)).toBe(binaryMarginColor('A', CELL_PASS, 0))
    expect(binaryMarginColor('A', CELL_PASS, 9)).toBe(binaryMarginColor('A', CELL_PASS, 1))
    expect(binaryMarginColor('A', CELL_PASS, Number.NaN)).toBe(binaryMarginColor('A', CELL_PASS, 0))
  })

  it('未知格恒为 unknownBase，与 m 无关', () => {
    expect(binaryMarginColor('A', CELL_UNKNOWN, 0)).toBe(BINARY_PALETTES.A.unknownBase)
    expect(binaryMarginColor('B', CELL_UNKNOWN, 1)).toBe(BINARY_PALETTES.B.unknownBase)
  })
})

describe('binaryMarginColor（A′ 版：A 的明度调制 + 正红 FAIL）', () => {
  it('PASS 与 A 完全一致，只有 FAIL 换成正红 #c0453e', () => {
    expect(BINARY_PALETTES.A2.passAnchor).toBe(BINARY_PALETTES.A.passAnchor)
    expect(BINARY_PALETTES.A2.passShadow).toBe(BINARY_PALETTES.A.passShadow)
    expect(BINARY_PALETTES.A2.failAnchor).toBe('#c0453e')
    expect(binaryMarginColor('A2', CELL_FAIL, 1)).toBe('#c0453e')
    expect(binaryMarginColor('A2', CELL_PASS, 1)).toBe('#26968a')
  })

  it('FAIL 暗端为同色相压暗，暗端仍偏红（不偏灰/偏黄）', () => {
    const dark = binaryMarginColor('A2', CELL_FAIL, 0)
    const n = Number.parseInt(dark.slice(1), 16)
    const r = (n >> 16) & 0xff
    const g = (n >> 8) & 0xff
    const b = n & 0xff
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    expect(g - b).toBeLessThan(10)
  })

  it('A′ 的热力色带不变，暖端仍是琥珀 #d99a2b', () => {
    expect(heatGradientStops(5, 'A2')).toEqual(heatGradientStops(5, 'A'))
    expect(heatGradientStops(5, 'A2')[4]).toBe('#d99a2b')
  })
})

describe('binaryMarginColor（B 版：降饱和 + 平坦）', () => {
  it('m 不参与计算，任意 m 得到同一色值', () => {
    expect(binaryMarginColor('B', CELL_PASS, 0)).toBe('#6b8a78')
    expect(binaryMarginColor('B', CELL_PASS, 1)).toBe('#6b8a78')
    expect(binaryMarginColor('B', CELL_FAIL, 0.4)).toBe('#a06a5e')
  })

  it('B 版饱和度明显低于旧版纯绿 / 纯红', () => {
    const saturation = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16)
      const r = ((n >> 16) & 0xff) / 255
      const g = ((n >> 8) & 0xff) / 255
      const b = (n & 0xff) / 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      return max === 0 ? 0 : (max - min) / max
    }
    // 旧版：#2fbf8f 饱和度约 0.75，#e2555a 约 0.60
    expect(saturation(BINARY_PALETTES.B.passAnchor)).toBeLessThan(0.25)
    expect(saturation(BINARY_PALETTES.B.failAnchor)).toBeLessThan(0.45)
  })
})

describe('binarySwatchStops', () => {
  it('A 版色卡从暗端渐变到锚点，且首尾与主图同源', () => {
    const stops = binarySwatchStops('A', CELL_PASS, 4)
    expect(stops).toHaveLength(4)
    expect(stops[0]).toBe(binaryMarginColor('A', CELL_PASS, 0))
    expect(stops[3]).toBe(binaryMarginColor('A', CELL_PASS, 1))
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
