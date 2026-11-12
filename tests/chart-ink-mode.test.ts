import { beforeEach, describe, expect, it } from 'vitest'
import { inkLayerAlpha, INK_LAYER_COUNT, INK_LAYER_DELAY } from '@renderer/chart/render2d'
import { useAppStore } from '@renderer/state/store'

/**
 * 显示模式与动效开关的单元测试（视觉重做）。
 *
 * 布局不跳动属于渲染层表现，这里只覆盖状态默认值与入场分层的数学行为；
 * “切换前后绘图区尺寸不变”由截图脚本对比 canvas 的 boundingBox 验证。
 */

describe('墨迹 / 逐格 显示模式', () => {
  beforeEach(() => {
    useAppStore.setState({ renderMode: 'ink', ambientMotion: false })
  })

  it('默认是墨迹模式，氛围动效默认关闭', () => {
    const state = useAppStore.getState()
    expect(state.renderMode).toBe('ink')
    expect(state.ambientMotion).toBe(false)
  })

  it('可以切换到逐格模式并切回，不影响其它显示状态', () => {
    useAppStore.getState().setRenderMode('cell')
    expect(useAppStore.getState().renderMode).toBe('cell')
    // 只改显示方式，不应改变配色模式
    expect(useAppStore.getState().colorMode).toBe('binary')

    useAppStore.getState().setRenderMode('ink')
    expect(useAppStore.getState().renderMode).toBe('ink')
  })

  it('氛围动效开关可独立切换', () => {
    useAppStore.getState().setAmbientMotion(true)
    expect(useAppStore.getState().ambientMotion).toBe(true)
    expect(useAppStore.getState().renderMode).toBe('ink')
    useAppStore.getState().setAmbientMotion(false)
    expect(useAppStore.getState().ambientMotion).toBe(false)
  })
})

describe('墨迹入场分层', () => {
  it('关闭动效时所有层立即为 1（静态首帧就是最终画面）', () => {
    for (let layer = 0; layer < INK_LAYER_COUNT; layer++) {
      expect(
        inkLayerAlpha(layer, { enabled: false, delaySpan: 0, cellDuration: 0, elapsed: 0 })
      ).toBe(1)
    }
  })

  it('同层批量、逐层延迟 30ms：第 N 层要等 N×30ms 才开始亮', () => {
    const motionAt = (elapsed: number) => ({ enabled: true, delaySpan: 0, cellDuration: 0, elapsed })
    // 第 0 层立刻开始；第 1 层在 29ms 时仍是 0，30ms 时开始
    expect(inkLayerAlpha(0, motionAt(0))).toBe(0)
    expect(inkLayerAlpha(0, motionAt(1))).toBeGreaterThan(0)
    expect(inkLayerAlpha(1, motionAt(INK_LAYER_DELAY - 1))).toBe(0)
    expect(inkLayerAlpha(1, motionAt(INK_LAYER_DELAY + 1))).toBeGreaterThan(0)

    // 最外层在第 5 层，延迟 = 150ms；总时长 = 150 + 240 = 390ms 内完成
    const last = INK_LAYER_COUNT - 1
    expect(inkLayerAlpha(last, motionAt(last * INK_LAYER_DELAY + 400))).toBe(1)
  })

  it('层与层之间严格递进（相同时间下，靠内的层不会更亮）', () => {
    const motion = { enabled: true, delaySpan: 0, cellDuration: 0, elapsed: 200 }
    let previous = Number.POSITIVE_INFINITY
    for (let layer = 0; layer < INK_LAYER_COUNT; layer++) {
      const alpha = inkLayerAlpha(layer, motion)
      expect(alpha).toBeLessThanOrEqual(previous + 1e-9)
      previous = alpha
    }
  })
})
