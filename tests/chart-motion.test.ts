import { describe, expect, it } from 'vitest'
import { cellAlpha } from '@renderer/chart/render2d'
import type { MotionInput } from '@renderer/chart/render2d'

/**
 * 入场动画测试（阶段 ③）：
 *  - `prefers-reduced-motion` 时必须瞬显；
 *  - 动画关闭时任何时刻都是不透明；
 *  - 对角线顺序：左上角色块先出现，右下角最后。
 */

const DELAY_SPAN = 260
const CELL_DURATION = 240

function motion(elapsed: number, enabled = true): MotionInput {
  return { enabled, delaySpan: DELAY_SPAN, cellDuration: CELL_DURATION, elapsed }
}

describe('cellAlpha', () => {
  it('动画关闭（减少动效）时恒为 1', () => {
    expect(cellAlpha(0, 0, 30, 30, motion(0, false))).toBe(1)
    expect(cellAlpha(29, 29, 30, 30, motion(0, false))).toBe(1)
  })

  it('elapsed = 0 时所有色块透明', () => {
    expect(cellAlpha(0, 0, 30, 30, motion(0))).toBe(0)
    expect(cellAlpha(29, 29, 30, 30, motion(0))).toBe(0)
  })

  it('对角线顺序：左上比右下先出现', () => {
    const midway = motion(130)
    const topLeft = cellAlpha(0, 0, 30, 30, midway)
    const bottomRight = cellAlpha(29, 29, 30, 30, midway)
    expect(topLeft).toBeGreaterThan(0)
    expect(topLeft).toBeLessThanOrEqual(1)
    expect(bottomRight).toBe(0)
  })

  it('动画结束后全部色块不透明', () => {
    const finished = motion(DELAY_SPAN + CELL_DURATION)
    expect(cellAlpha(0, 0, 30, 30, finished)).toBe(1)
    expect(cellAlpha(15, 15, 30, 30, finished)).toBe(1)
    expect(cellAlpha(29, 29, 30, 30, finished)).toBe(1)
  })

  it('单格网格（1 × 1）不会除零', () => {
    expect(cellAlpha(0, 0, 1, 1, motion(100))).toBeGreaterThan(0)
    expect(cellAlpha(0, 0, 1, 1, motion(DELAY_SPAN + CELL_DURATION))).toBe(1)
  })
})
