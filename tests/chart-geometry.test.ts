import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PADDING,
  cellCenter,
  cellRect,
  computeAxisEdges,
  computeGeometry,
  hitTest,
  pickTickIndices,
  tickDecimals
} from '@renderer/chart/geometry'

/**
 * 2D 图表几何测试（阶段 ③ 验收：30 个采样点必须画出 30 个色块、
 * 非均匀轴宽度正确、hitTest 与刻度抽稀符合预期）。
 */

/** 30 个等间隔 x 采样：0.60 → 0.89 */
const X_VALUES = Array.from({ length: 30 }, (_, i) => Number((0.6 + i * 0.01).toFixed(2)))
/** 30 个等间隔 y 采样：100 → 390 */
const Y_VALUES = Array.from({ length: 30 }, (_, i) => 100 + i * 10)

const WIDTH = 800
const HEIGHT = 600

function makeGeometry(xValues: number[] = X_VALUES, yValues: number[] = Y_VALUES) {
  return computeGeometry(WIDTH, HEIGHT, DEFAULT_PADDING, xValues, yValues)
}

describe('computeAxisEdges', () => {
  it('n 个采样值产生 n+1 条边界，首尾各外扩半格', () => {
    const edges = computeAxisEdges(X_VALUES)
    expect(edges).toHaveLength(31)
    expect(edges[0]).toBeCloseTo(0.6 - 0.005, 10)
    expect(edges[30]).toBeCloseTo(0.89 + 0.005, 10)
    // 中间边界是相邻采样值的中点
    expect(edges[15]).toBeCloseTo((X_VALUES[14] + X_VALUES[15]) / 2, 10)
  })

  it('单值轴也能画出 1 个色块（±0.5 的退化边界）', () => {
    expect(computeAxisEdges([2])).toEqual([1.5, 2.5])
  })

  it('空轴返回空数组，不抛错', () => {
    expect(computeAxisEdges([])).toEqual([])
  })
})

describe('computeGeometry', () => {
  it('数据区尺寸 = 画布尺寸减去留白', () => {
    const geometry = makeGeometry()
    expect(geometry.plot).toEqual({ x: 68, y: 20, w: 628, h: 532 })
  })

  it('30 × 30 网格：x / y 各有 31 条边界，共 900 个色块', () => {
    const geometry = makeGeometry()
    expect(geometry.x.edges).toHaveLength(31)
    expect(geometry.y.edges).toHaveLength(31)

    // 关键回归：常见错误是 30 个采样点只画出 29 个色块
    expect(geometry.x.edges.length - 1).toBe(geometry.x.values.length)
    expect(geometry.y.edges.length - 1).toBe(geometry.y.values.length)

    // 所有色块面积之和 = 数据区面积（既无缝隙也无重叠）
    let area = 0
    for (let iy = 0; iy < Y_VALUES.length; iy++) {
      for (let ix = 0; ix < X_VALUES.length; ix++) {
        const rect = cellRect(geometry, ix, iy)
        expect(rect.w).toBeGreaterThan(0)
        expect(rect.h).toBeGreaterThan(0)
        area += rect.w * rect.h
      }
    }
    expect(area).toBeCloseTo(geometry.plot.w * geometry.plot.h, 4)
  })

  it('非均匀轴按真实值分配宽度（0,1,2,5 → 1:1:2:3）', () => {
    const geometry = makeGeometry([0, 1, 2, 5], [0, 1, 2, 5])
    const widths = [0, 1, 2, 3].map((ix) => cellRect(geometry, ix, 0).w)
    expect(widths[0]).toBeCloseTo(geometry.plot.w / 7, 6)
    expect(widths[2] / widths[0]).toBeCloseTo(2, 6)
    expect(widths[3] / widths[0]).toBeCloseTo(3, 6)
    expect(widths.reduce((sum, w) => sum + w, 0)).toBeCloseTo(geometry.plot.w, 6)
  })

  it('y 轴方向正确：iy = 0 在最底部，iy 越大越靠上', () => {
    const geometry = makeGeometry()
    const bottom = cellCenter(geometry, 0, 0)
    const top = cellCenter(geometry, 0, Y_VALUES.length - 1)
    expect(bottom.y).toBeGreaterThan(top.y)
    // 最底行的下边界 = 数据区底边，最顶行的上边界 = 数据区顶边
    expect(cellRect(geometry, 0, 0).y + cellRect(geometry, 0, 0).h).toBeCloseTo(
      geometry.plot.y + geometry.plot.h,
      6
    )
    expect(cellRect(geometry, 0, Y_VALUES.length - 1).y).toBeCloseTo(geometry.plot.y, 6)
  })

  it('宽度或高度过小时 plot 被夹到 0，不出现负尺寸', () => {
    const geometry = computeGeometry(40, 30, DEFAULT_PADDING, X_VALUES, Y_VALUES)
    expect(geometry.plot.w).toBe(0)
    expect(geometry.plot.h).toBe(0)
  })
})

describe('hitTest', () => {
  it('命中格子中心返回自身索引（覆盖四个角与中央）', () => {
    const geometry = makeGeometry()
    const spots: Array<[number, number]> = [
      [0, 0],
      [29, 0],
      [0, 29],
      [29, 29],
      [14, 7]
    ]
    for (const [ix, iy] of spots) {
      const center = cellCenter(geometry, ix, iy)
      expect(hitTest(geometry, center.x, center.y)).toEqual({ ix, iy })
    }
  })

  it('第 1 个与第 30 个色块都能被命中（不是 29 个）', () => {
    const geometry = makeGeometry()
    expect(hitTest(geometry, cellCenter(geometry, 0, 0).x, 100)?.ix).toBe(0)
    expect(hitTest(geometry, cellCenter(geometry, 29, 0).x, 100)?.ix).toBe(29)
  })

  it('数据区之外（轴线、留白、图例）返回 null', () => {
    const geometry = makeGeometry()
    const { plot } = geometry
    expect(hitTest(geometry, plot.x - 1, plot.y + 10)).toBeNull()
    expect(hitTest(geometry, plot.x + 10, plot.y - 1)).toBeNull()
    expect(hitTest(geometry, plot.x + 10, plot.y + plot.h)).toBeNull()
    expect(hitTest(geometry, plot.x + plot.w, plot.y + 10)).toBeNull()
  })
})

describe('pickTickIndices', () => {
  it('首尾刻度必须保留，且相邻标签间距不小于 minGap', () => {
    const positions = X_VALUES.map((_, i) => (i * 628) / 29)
    const picked = pickTickIndices(positions, 56)
    expect(picked[0]).toBe(0)
    expect(picked[picked.length - 1]).toBe(29)
    for (let i = 1; i < picked.length; i++) {
      expect(positions[picked[i]] - positions[picked[i - 1]]).toBeGreaterThanOrEqual(56 - 1e-9)
    }
  })

  it('刻度极度密集时仍保留首尾两个标签', () => {
    const positions = Array.from({ length: 30 }, (_, i) => i * 2)
    const picked = pickTickIndices(positions, 56)
    expect(picked).toContain(0)
    expect(picked).toContain(29)
  })

  it('单个刻度与空数组的退化情况', () => {
    expect(pickTickIndices([10], 56)).toEqual([0])
    expect(pickTickIndices([], 56)).toEqual([])
  })
})

describe('tickDecimals', () => {
  it('整数不显示小数位', () => {
    expect(tickDecimals([1, 2, 3])).toBe(0)
    expect(tickDecimals([100, 200, 300])).toBe(0)
  })

  it('按真实步长决定位数（0.1 → 1 位，0.05 → 2 位，0.25 → 2 位）', () => {
    expect(tickDecimals([2.0, 2.1, 2.2])).toBe(1)
    expect(tickDecimals([0.6, 0.65, 0.7])).toBe(2)
    expect(tickDecimals([0.25, 0.5, 0.75])).toBe(2)
  })

  it('单值与空数组不抛错', () => {
    expect(tickDecimals([1.5])).toBe(1)
    expect(tickDecimals([])).toBe(0)
  })
})
