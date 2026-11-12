import { describe, expect, it } from 'vitest'
import {
  ENTRANCE_LAYER_COUNT,
  ENTRANCE_LAYER_DELAY,
  ENTRANCE_TOTAL,
  cellAlpha,
  cellCornerRadius
} from '@renderer/chart/render2d'
import type { MotionInput } from '@renderer/chart/render2d'

/**
 * 入场动画 + 圆角单元格测试：
 *  - `prefers-reduced-motion` / 动画关闭时必须瞬显；
 *  - 入场按“到图心距离”分 6 层，每层 30ms，同层批量点亮；
 *  - 圆角半径随格子短边自适应，并夹在 1.5–5，100×100 时不会糊成圆点。
 */

function motion(elapsed: number, enabled = true): MotionInput {
  return { enabled, elapsed }
}

describe('cellAlpha（按距中心的距离分层）', () => {
  it('动画关闭（减少动效）时恒为 1', () => {
    expect(cellAlpha(0, 0, 30, 30, motion(0, false))).toBe(1)
    expect(cellAlpha(29, 29, 30, 30, motion(0, false))).toBe(1)
  })

  it('elapsed = 0 时所有色块透明', () => {
    expect(cellAlpha(0, 0, 30, 30, motion(0))).toBe(0)
    expect(cellAlpha(14, 14, 30, 30, motion(0))).toBe(0)
    expect(cellAlpha(29, 29, 30, 30, motion(0))).toBe(0)
  })

  it('中心先亮、角落后亮（从中心向外扩散）', () => {
    // 第 4 层开始的时刻：中层已经亮起，角落（第 5 层）仍未开始
    const midway = motion(ENTRANCE_LAYER_DELAY * 4)
    const center = cellAlpha(15, 15, 30, 30, midway)
    const corner = cellAlpha(0, 0, 30, 30, midway)
    expect(center).toBeGreaterThan(0)
    expect(center).toBeLessThanOrEqual(1)
    expect(corner).toBe(0)
  })

  it('最后一层相对第一层正好延后 (层数-1) × 30ms', () => {
    // 角落落在最后一层；延迟 = (6-1) × 30 = 150ms
    const beforeLast = motion((ENTRANCE_LAYER_COUNT - 2) * ENTRANCE_LAYER_DELAY)
    expect(cellAlpha(0, 0, 30, 30, beforeLast)).toBe(0)
    const atLast = motion((ENTRANCE_LAYER_COUNT - 1) * ENTRANCE_LAYER_DELAY + 1)
    expect(cellAlpha(0, 0, 30, 30, atLast)).toBeGreaterThan(0)
  })

  it('动画结束后全部色块不透明', () => {
    const finished = motion(ENTRANCE_TOTAL)
    expect(cellAlpha(0, 0, 30, 30, finished)).toBe(1)
    expect(cellAlpha(15, 15, 30, 30, finished)).toBe(1)
    expect(cellAlpha(29, 29, 30, 30, finished)).toBe(1)
  })

  it('单格网格（1 × 1）不会除零', () => {
    expect(cellAlpha(0, 0, 1, 1, motion(100))).toBeGreaterThan(0)
    expect(cellAlpha(0, 0, 1, 1, motion(ENTRANCE_TOTAL))).toBe(1)
  })
})

describe('cellCornerRadius（自适应圆角）', () => {
  it('30×30 的格子取短边 18%，落在 1.5–5 之间', () => {
    // 30×30 时格子约 28×24，去掉 1px 缝后短边 23 → 4.14
    const r = cellCornerRadius(27, 23)
    expect(r).toBeCloseTo(23 * 0.18, 6)
    expect(r).toBeGreaterThan(1.5)
    expect(r).toBeLessThan(5)
  })

  it('100×100 时收敛到下限 1.5，不会糊成圆点', () => {
    expect(cellCornerRadius(7.5, 6.4)).toBe(1.5)
  })

  it('格子很大时封顶 5，避免变成胶囊/圆角过大', () => {
    expect(cellCornerRadius(120, 90)).toBe(5)
  })

  it('非法尺寸返回 0，不产生 NaN 路径', () => {
    expect(cellCornerRadius(0, 10)).toBe(0)
    expect(cellCornerRadius(Number.NaN, 10)).toBe(0)
  })
})
