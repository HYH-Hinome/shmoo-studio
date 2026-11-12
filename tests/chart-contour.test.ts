import { describe, expect, it } from 'vitest'
import { INK_AMPLITUDE_RATIO, INK_MAX_DEVIATION_RATIO, MIN_INK_AREA, buildInkScene } from '@renderer/chart/contour'
import type { Pt } from '@renderer/chart/contour'
import { createNoise2D } from '@renderer/chart/noise'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'

/**
 * 轮廓提取与墨迹层测试（视觉重做）：
 *  - marching squares 精确轮廓必须落在真实格子边界上；
 *  - 面积 < 4 格降级为精确轮廓（不抖动）；
 *  - 墨迹采样点偏离精确轮廓不超过 15% 格宽；
 *  - 缺测格阻断：轮廓不跨过 NaN，墨迹也不得侵入；
 *  - 场景缓存复用同一对象（不逐帧重算）。
 *
 * 坐标约定与 geometry.ts 一致：edgesX 升序；edgesY 从底到顶、像素值递减。
 */

const NX = 12
const NY = 12
const CELL = 10

/** 构造网格线：x 从左到右递升，y 从底到顶递减 */
function makeEdges(): { edgesX: number[]; edgesY: number[] } {
  const edgesX = Array.from({ length: NX + 1 }, (_, i) => i * CELL)
  const edgesY = Array.from({ length: NY + 1 }, (_, j) => NY * CELL - j * CELL)
  return { edgesX, edgesY }
}

/** 全 PASS 网格，按回调把指定格改成 FAIL / UNKNOWN */
function makeState(
  mutate: (ix: number, iy: number, index: number) => number = () => CELL_PASS
): Uint8Array {
  const state = new Uint8Array(NX * NY)
  for (let iy = 0; iy < NY; iy++) {
    for (let ix = 0; ix < NX; ix++) {
      state[iy * NX + ix] = mutate(ix, iy, iy * NX + ix)
    }
  }
  return state
}

/** 点到折线（含闭合段）的最近距离 */
function distanceToPolyline(point: Pt, polyline: Pt[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]
    const b = polyline[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq))
    const projX = a.x + dx * t
    const projY = a.y + dy * t
    best = Math.min(best, Math.hypot(point.x - projX, point.y - projY))
  }
  return best
}

describe('simplex noise', () => {
  it('相同 seed 结果一致，不同 seed 结果不同', () => {
    const a = createNoise2D(7)
    const b = createNoise2D(7)
    const c = createNoise2D(8)
    expect(a(1.23, 4.56)).toBe(b(1.23, 4.56))
    expect(a(1.23, 4.56)).not.toBe(c(1.23, 4.56))
  })

  it('输出落在 [-1, 1]，且不是常量', () => {
    const noise = createNoise2D(42)
    const values = Array.from({ length: 200 }, (_, i) => noise(i * 0.37, i * 0.61))
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(-1)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.3)
  })
})

describe('精确轮廓（marching squares）', () => {
  it('9 格 FAIL 块得到一个闭合环，顶点全部落在格子边界上', () => {
    const { edgesX, edgesY } = makeEdges()
    const state = makeState((ix, iy) => (ix >= 2 && ix <= 4 && iy >= 2 && iy <= 4 ? CELL_FAIL : CELL_PASS))
    const scene = buildInkScene(edgesX, edgesY, state, 11)

    const failRegions = scene.regions.filter((region) => region.state === 'fail')
    expect(failRegions).toHaveLength(1)
    expect(failRegions[0].area).toBe(9)
    expect(failRegions[0].exactLoops).toHaveLength(1)

    const loop = failRegions[0].exactLoops[0]
    expect(loop.length).toBeGreaterThanOrEqual(4)
    // 每个顶点的 x 或 y 必须落在某条格线上（不允许出现斜边或半格偏移）
    for (const pt of loop) {
      const onVertical = edgesX.some((edge) => Math.abs(edge - pt.x) < 1e-9)
      const onHorizontal = edgesY.some((edge) => Math.abs(edge - pt.y) < 1e-9)
      expect(onVertical || onHorizontal).toBe(true)
    }
    // 首尾闭合
    expect(loop[0]).toEqual(loop[loop.length - 1])
  })

  it('轮廓包围盒与 3×3 格块一致（不内缩、不外扩）', () => {
    const { edgesX, edgesY } = makeEdges()
    const state = makeState((ix, iy) => (ix >= 2 && ix <= 4 && iy >= 2 && iy <= 4 ? CELL_FAIL : CELL_PASS))
    const scene = buildInkScene(edgesX, edgesY, state, 12)
    const loop = scene.regions.find((region) => region.state === 'fail')?.exactLoops[0] ?? []
    const xs = loop.map((pt) => pt.x)
    const ys = loop.map((pt) => pt.y)
    expect(Math.min(...xs)).toBeCloseTo(edgesX[2], 9)
    expect(Math.max(...xs)).toBeCloseTo(edgesX[5], 9)
    expect(Math.min(...ys)).toBeCloseTo(edgesY[5], 9)
    expect(Math.max(...ys)).toBeCloseTo(edgesY[2], 9)
  })
})

describe('降级规则', () => {
  it('单格 FAIL：面积 1 格，不施加噪声位移', () => {
    const { edgesX, edgesY } = makeEdges()
    const state = makeState((ix, iy) => (ix === 5 && iy === 5 ? CELL_FAIL : CELL_PASS))
    const scene = buildInkScene(edgesX, edgesY, state, 13)
    const fail = scene.regions.find((region) => region.state === 'fail')
    expect(fail?.area).toBe(1)
    expect(fail?.inkLoops.every((loop) => loop === null)).toBe(true)
    expect(fail?.softened).toBe(false)
  })

  it('2×2 块（面积 4 格）允许位移，但偏差不超过 15% 格宽', () => {
    const { edgesX, edgesY } = makeEdges()
    const state = makeState((ix, iy) => (ix >= 4 && ix <= 5 && iy >= 4 && iy <= 5 ? CELL_FAIL : CELL_PASS))
    const scene = buildInkScene(edgesX, edgesY, state, 14)
    const fail = scene.regions.find((region) => region.state === 'fail')
    expect(fail?.area).toBe(MIN_INK_AREA)
    const ink = fail?.inkLoops[0]
    const exact = fail?.exactLoops[0] ?? []
    if (ink) {
      for (const pt of ink) {
        expect(distanceToPolyline(pt, exact)).toBeLessThanOrEqual(CELL * INK_MAX_DEVIATION_RATIO + 1e-6)
      }
      // 振幅上限 14%：任一墨迹点相对对应精确点的偏移不应超过这个量级的两倍
      const maxOffset = Math.max(...ink.map((pt) => distanceToPolyline(pt, exact)))
      expect(maxOffset).toBeLessThanOrEqual(CELL * INK_AMPLITUDE_RATIO + 2)
    }
  })

  it('面积 >= 4 格的大块区域会生成墨迹轮廓（softened = true）', () => {
    const { edgesX, edgesY } = makeEdges()
    const state = makeState((ix, iy) => (ix >= 2 && ix <= 7 && iy >= 2 && iy <= 7 ? CELL_FAIL : CELL_PASS))
    const scene = buildInkScene(edgesX, edgesY, state, 15)
    const fail = scene.regions.find((region) => region.state === 'fail')
    expect(fail?.softened).toBe(true)
    expect(fail?.inkLoops[0]?.length ?? 0).toBeGreaterThan(8)
  })
})

describe('缺测格阻断', () => {
  it('缺测格把 FAIL 区切成两个互不相连的区域', () => {
    const { edgesX, edgesY } = makeEdges()
    // 中间一列设为缺测，两侧各有一块 FAIL
    const state = makeState((ix, iy) => {
      if (ix === 6) return CELL_UNKNOWN
      if (iy === 5 && (ix === 5 || ix === 7)) return CELL_FAIL
      return CELL_PASS
    })
    const scene = buildInkScene(edgesX, edgesY, state, 16)
    const failRegions = scene.regions.filter((region) => region.state === 'fail')
    expect(failRegions).toHaveLength(2)
    // 精确轮廓不得跨进缺测列（x ∈ (60, 70)），贴边（x = 60 / 70）是合法的
    for (const region of failRegions) {
      for (const loop of region.exactLoops) {
        for (const pt of loop) {
          expect(pt.x > 60 && pt.x < 70).toBe(false)
        }
      }
    }
  })

  it('墨迹采样点不会落入缺测格', () => {
    const { edgesX, edgesY } = makeEdges()
    // 一块较大的 FAIL 区旁边紧贴一列缺测：要求墨迹不得侵入缺测列
    const state = makeState((ix, iy) => {
      if (ix === 8) return CELL_UNKNOWN
      if (ix >= 2 && ix <= 7 && iy >= 2 && iy <= 9) return CELL_FAIL
      return CELL_PASS
    })
    const scene = buildInkScene(edgesX, edgesY, state, 17)
    const fail = scene.regions.find((region) => region.state === 'fail')
    const ink = fail?.inkLoops[0]
    if (ink) {
      for (const pt of ink) {
        // 缺测列的像素区间 [80, 90)；墨迹不允许进入
        const insideUnknown = pt.x > 80 && pt.x < 90 && pt.y > 10 && pt.y < 100
        expect(insideUnknown).toBe(false)
      }
    }
  })
})

describe('缓存', () => {
  it('同一状态数组与尺寸返回同一场景对象（不逐帧重算）', () => {
    const { edgesX, edgesY } = makeEdges()
    const state = makeState((ix, iy) => (ix >= 2 && ix <= 6 && iy >= 2 && iy <= 6 ? CELL_FAIL : CELL_PASS))
    const first = buildInkScene(edgesX, edgesY, state, 21)
    const second = buildInkScene(edgesX, edgesY, state, 21)
    expect(second).toBe(first)
  })
})
