import { beforeEach, describe, expect, it } from 'vitest'
import type { Axis, ShmooDataset, SiteGrid, SpecLimit } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'
import {
  DOUBLE_CLICK_MS,
  TOOLTIP_HEIGHT,
  TOOLTIP_PAD,
  TOOLTIP_WIDTH,
  classifyClick,
  computeBoxStats,
  computeTooltipPlacement,
  moveCell,
  normalizeBox,
  rowEdgeCell
} from '../src/renderer/chart/interaction'
import { useAppStore } from '../src/renderer/state/store'

/**
 * 阶段 ⑤ 交互层测试。
 *
 * 交互的 DOM 部分（指针时序、键盘事件）依赖真实布局，jsdom 里拿不到 900 格的几何；
 * 因此这里覆盖“决定行为的那部分纯逻辑”，再配合浏览器截图 / 自动化做端到端验证：
 *  1. 浮层避让：四个边缘都不得溢出容器（几何断言，比“看起来没挡住”更可靠）；
 *  2. 键盘移动：边界夹紧、Home/End、Shift 扩展的锚点不被破坏；
 *  3. 框选统计：缺测口径、通过率、min/max/avg、最差 margin；
 *  4. 单击 / 双击：250ms 窗口内同格才算双击；
 *  5. 跨视图重置：切站点 / 进切片 / 换数据集后，锁定与框选不残留。
 */

const SPEC: SpecLimit = { mode: 'window', min: 740, max: 860 }

/** 3×2 网格（行优先，iy=0 是底行）：700 750 NaN / 800 870 900 */
function makeFixture(): { dataset: ShmooDataset; site: SiteGrid } {
  const values = [700, 750, NaN, 800, 870, 900]
  const value = new Float32Array(values)
  const pass = new Uint8Array(
    values.map((v) => (Number.isFinite(v) ? (v >= 740 && v <= 860 ? CELL_PASS : CELL_FAIL) : CELL_UNKNOWN))
  )
  const site: SiteGrid = {
    siteId: 'S1',
    siteLabel: 'SITE_A',
    value,
    pass,
    valueRange: { min: 700, max: 900 },
    knownCount: 5,
    passCount: 2
  }
  const xAxis: Axis = { key: 'x', label: 'VDD', unit: 'V', values: [0.8, 0.9, 1.0], scale: 'linear' }
  const yAxis: Axis = { key: 'y', label: 'PERIOD', unit: 'ns', values: [2.4, 2.5], scale: 'linear' }
  const dataset: ShmooDataset = {
    id: 'ds-interaction',
    fileName: 'fixture.csv',
    filePath: null,
    importedAt: 0,
    kind: '2d',
    meta: {},
    title: 'FIXTURE',
    valueLabel: 'VOH',
    valueUnit: 'mV',
    xAxis,
    yAxis,
    sites: [
      site,
      { ...site, siteId: 'S2', siteLabel: 'SITE_B' }
    ],
    valueType: 'measured',
    passSource: 'derived',
    spec: SPEC,
    issues: [],
    revision: 0
  }
  return { dataset, site }
}

describe('浮层避让', () => {
  const container = { width: 1000, height: 600 }
  const tip = { width: TOOLTIP_WIDTH, height: TOOLTIP_HEIGHT }

  /** 浮层必须完整落在容器内（含 PAD 留白），否则会盖住/被裁掉数据 */
  function expectInside(p: { left: number; top: number }): void {
    expect(p.left).toBeGreaterThanOrEqual(TOOLTIP_PAD)
    expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_PAD)
    expect(p.left + tip.width).toBeLessThanOrEqual(container.width - TOOLTIP_PAD)
    expect(p.top + tip.height).toBeLessThanOrEqual(container.height - TOOLTIP_PAD)
  }

  it('中间格子：默认在右下方，不翻转', () => {
    const placement = computeTooltipPlacement({ x: 400, y: 250, w: 30, h: 24 }, container, tip)
    expect(placement.flipX).toBe(false)
    expect(placement.flipY).toBe(false)
    expect(placement.left).toBeGreaterThan(430)
    expect(placement.top).toBeGreaterThan(274)
    expectInside(placement)
  })

  it('靠近右边缘：翻到格子左侧，且不覆盖格子', () => {
    const cell = { x: 940, y: 250, w: 30, h: 24 }
    const placement = computeTooltipPlacement(cell, container, tip)
    expect(placement.flipX).toBe(true)
    expect(placement.left + tip.width).toBeLessThanOrEqual(cell.x)
    expectInside(placement)
  })

  it('靠近下边缘：翻到格子上方，且不覆盖格子', () => {
    const cell = { x: 400, y: 550, w: 30, h: 24 }
    const placement = computeTooltipPlacement(cell, container, tip)
    expect(placement.flipY).toBe(true)
    expect(placement.top + tip.height).toBeLessThanOrEqual(cell.y)
    expectInside(placement)
  })

  it('右下角同时翻转，仍然完整落在容器内', () => {
    const cell = { x: 960, y: 570, w: 30, h: 24 }
    const placement = computeTooltipPlacement(cell, container, tip)
    expect(placement.flipX).toBe(true)
    expect(placement.flipY).toBe(true)
    expectInside(placement)
  })

  it('左上角放不下时夹到容器内（不出现负数坐标）', () => {
    const placement = computeTooltipPlacement({ x: 0, y: 0, w: 10, h: 10 }, container, tip)
    expect(placement.flipX).toBe(false)
    expect(placement.flipY).toBe(false)
    expectInside(placement)
  })

  it('容器比浮层还小时也不出现负坐标', () => {
    const placement = computeTooltipPlacement(
      { x: 10, y: 10, w: 10, h: 10 },
      { width: 100, height: 80 },
      tip
    )
    expect(placement.left).toBeGreaterThanOrEqual(TOOLTIP_PAD)
    expect(placement.top).toBeGreaterThanOrEqual(TOOLTIP_PAD)
  })
})

describe('键盘移动', () => {
  it('方向键在网格内移动，并在四边夹紧', () => {
    expect(moveCell({ ix: 1, iy: 1 }, 1, 0, 3, 2)).toEqual({ ix: 2, iy: 1 })
    expect(moveCell({ ix: 0, iy: 0 }, -1, -1, 3, 2)).toEqual({ ix: 0, iy: 0 })
    expect(moveCell({ ix: 2, iy: 1 }, 1, 1, 3, 2)).toEqual({ ix: 2, iy: 1 })
  })

  it('Home / End 到当前行的行首 / 行尾，y 不变', () => {
    expect(rowEdgeCell({ ix: 1, iy: 0 }, 'start', 3)).toEqual({ ix: 0, iy: 0 })
    expect(rowEdgeCell({ ix: 1, iy: 0 }, 'end', 3)).toEqual({ ix: 2, iy: 0 })
    // 空网格不应产生负索引
    expect(rowEdgeCell({ ix: 0, iy: 0 }, 'end', 0)).toEqual({ ix: 0, iy: 0 })
  })

  it('Shift 扩展：锚点方向反过来时框选仍归一化', () => {
    const anchor = { ix: 2, iy: 1 }
    const focus = { ix: 0, iy: 0 }
    expect(normalizeBox(anchor, focus)).toEqual({ ix0: 0, ix1: 2, iy0: 0, iy1: 1 })
  })
})

describe('框选统计', () => {
  const { site } = makeFixture()

  it('全网格：格数、PASS/FAIL、缺测、通过率、value 范围 / 均值、最差 margin', () => {
    const stats = computeBoxStats(site, 3, { ix0: 0, ix1: 2, iy0: 0, iy1: 1 }, SPEC)
    expect(stats.cells).toBe(6)
    expect(stats.pass).toBe(2)
    expect(stats.fail).toBe(3)
    expect(stats.unknown).toBe(1)
    // 通过率只用已知格：2 / 5
    expect(stats.passRate).toBeCloseTo(2 / 5, 10)
    expect(stats.valueMin).toBe(700)
    expect(stats.valueMax).toBe(900)
    expect(stats.valueAvg).toBeCloseTo(804, 10)
    // 窗口 740–860：700 / 900 都差 40，是最差 margin
    expect(stats.worstMargin).toBeCloseTo(-40, 10)
  })

  it('子区域只统计框内格子，缺测不参与 value 与 margin', () => {
    // 只框 iy=0 的 3 格（700 / 750 / 缺测）
    const stats = computeBoxStats(site, 3, { ix0: 0, ix1: 2, iy0: 0, iy1: 0 }, SPEC)
    expect(stats.cells).toBe(3)
    expect(stats.pass).toBe(1)
    expect(stats.fail).toBe(1)
    expect(stats.unknown).toBe(1)
    expect(stats.passRate).toBe(0.5)
    expect(stats.valueMin).toBe(700)
    expect(stats.valueMax).toBe(750)
    expect(stats.valueAvg).toBeCloseTo(725, 10)
    expect(stats.worstMargin).toBeCloseTo(-40, 10)
  })

  it('全缺测区域：通过率与 value / margin 都是 null，不出现 NaN', () => {
    const empty: SiteGrid = {
      ...site,
      value: new Float32Array([NaN, NaN, NaN, NaN, NaN, NaN]),
      pass: new Uint8Array(6).fill(CELL_UNKNOWN),
      knownCount: 0,
      passCount: 0
    }
    const stats = computeBoxStats(empty, 3, { ix0: 0, ix1: 2, iy0: 0, iy1: 1 }, SPEC)
    expect(stats.passRate).toBeNull()
    expect(stats.valueMin).toBeNull()
    expect(stats.worstMargin).toBeNull()
  })
})

describe('单击 / 双击判定', () => {
  const cell = { ix: 4, iy: 2 }

  it('首次点击永远是单击', () => {
    expect(classifyClick(null, cell, 1000)).toBe('single')
  })

  it('250ms 内同一格的第二次点击是双击', () => {
    expect(classifyClick({ cell, time: 1000 }, cell, 1000 + DOUBLE_CLICK_MS)).toBe('double')
    expect(classifyClick({ cell, time: 1000 }, cell, 1150)).toBe('double')
  })

  it('超过 250ms 的第二次点击仍是单击', () => {
    expect(classifyClick({ cell, time: 1000 }, cell, 1000 + DOUBLE_CLICK_MS + 1)).toBe('single')
  })

  it('快速点击不同格子不会被误判为双击', () => {
    expect(classifyClick({ cell, time: 1000 }, { ix: 5, iy: 2 }, 1100)).toBe('single')
  })

  it('时间倒退（系统时钟/伪造事件）按单击处理', () => {
    expect(classifyClick({ cell, time: 2000 }, cell, 1000)).toBe('single')
  })
})

describe('跨视图状态重置', () => {
  const { dataset } = makeFixture()

  beforeEach(() => {
    useAppStore.setState({
      dataset,
      activeSiteId: 'S1',
      spec: dataset.spec,
      slice: null,
      sliceMarker: null,
      selection: null,
      box: null
    })
  })

  it('锁定与框选可正常写入', () => {
    useAppStore.getState().toggleSelection({ ix: 2, iy: 1 })
    useAppStore.getState().setBox({ anchor: { ix: 0, iy: 0 }, focus: { ix: 2, iy: 1 } })
    expect(useAppStore.getState().selection).toEqual({ ix: 2, iy: 1 })
    expect(useAppStore.getState().box).toEqual({
      anchor: { ix: 0, iy: 0 },
      focus: { ix: 2, iy: 1 }
    })
  })

  it('越界索引被拒绝，不会锁到不存在的格子', () => {
    useAppStore.getState().toggleSelection({ ix: 99, iy: 99 })
    expect(useAppStore.getState().selection).toBeNull()
    useAppStore.getState().setBox({ anchor: { ix: -5, iy: -5 }, focus: { ix: 99, iy: 99 } })
    // 框选端点夹到网格内，而不是保存负值 / 越界值
    expect(useAppStore.getState().box).toEqual({
      anchor: { ix: 0, iy: 0 },
      focus: { ix: 2, iy: 1 }
    })
  })

  it('切换站点清空锁定与框选', () => {
    useAppStore.getState().toggleSelection({ ix: 1, iy: 0 })
    useAppStore.getState().setBox({ anchor: { ix: 0, iy: 0 }, focus: { ix: 1, iy: 0 } })
    useAppStore.getState().setActiveSite('S2')
    expect(useAppStore.getState().selection).toBeNull()
    expect(useAppStore.getState().box).toBeNull()
  })

  it('进入切片清空锁定与框选（返回时从干净状态开始）', () => {
    useAppStore.getState().toggleSelection({ ix: 1, iy: 0 })
    useAppStore.getState().setBox({ anchor: { ix: 0, iy: 0 }, focus: { ix: 1, iy: 0 } })
    useAppStore.getState().openSlice({ axis: 'row', index: 1 })
    expect(useAppStore.getState().selection).toBeNull()
    expect(useAppStore.getState().box).toBeNull()
  })

  it('换数据集清空锁定与框选', () => {
    useAppStore.getState().toggleSelection({ ix: 1, iy: 0 })
    useAppStore.getState().setBox({ anchor: { ix: 0, iy: 0 }, focus: { ix: 1, iy: 0 } })
    useAppStore.getState().setDataset({ ...dataset, id: 'ds-next', revision: 1 })
    expect(useAppStore.getState().selection).toBeNull()
    expect(useAppStore.getState().box).toBeNull()
  })

  it('再次单击同一格解除锁定', () => {
    useAppStore.getState().toggleSelection({ ix: 1, iy: 0 })
    useAppStore.getState().toggleSelection({ ix: 1, iy: 0 })
    expect(useAppStore.getState().selection).toBeNull()
  })

  it('clearInteraction 同时清掉锁定与框选', () => {
    useAppStore.getState().toggleSelection({ ix: 1, iy: 0 })
    useAppStore.getState().setBox({ anchor: { ix: 0, iy: 0 }, focus: { ix: 1, iy: 0 } })
    useAppStore.getState().clearInteraction()
    expect(useAppStore.getState().selection).toBeNull()
    expect(useAppStore.getState().box).toBeNull()
  })
})
