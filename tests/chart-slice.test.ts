import { describe, expect, it } from 'vitest'
import type { Axis, ShmooDataset, SiteGrid, SpecLimit } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'
import {
  buildSliceDataset,
  buildSliceSeries,
  formatAxisValue,
  worstMarginOfSeries
} from '../src/renderer/chart/slice'
import { findPassRuns } from '../src/renderer/chart/oneD'
import { useAppStore } from '../src/renderer/state/store'

/**
 * 阶段 ④ 追加功能：2D → 1D 切片。
 * 覆盖：序列提取（行/列）、越界与非法输入、缺测传播、统计值、面包屑状态机。
 */

const SPEC: SpecLimit = { mode: 'window', min: 740, max: 860 }

function axis(label: string, values: number[], unit = 'V'): Axis {
  return {
    key: 'x',
    label,
    unit,
    values,
    scale: 'linear'
  }
}

/**
 * 3×2 网格（nx=3, ny=2），行优先：
 *   iy=0: 700 750 NaN
 *   iy=1: 800 870 900
 */
function makeFixture(): { dataset: ShmooDataset; site: SiteGrid } {
  const values = [700, 750, NaN, 800, 870, 900]
  const value = new Float32Array(values)
  const pass = new Uint8Array(values.map((v) => (Number.isFinite(v) ? (v >= 740 && v <= 860 ? CELL_PASS : CELL_FAIL) : CELL_UNKNOWN)))
  const site: SiteGrid = {
    siteId: 'S1',
    siteLabel: 'SITE_A',
    value,
    pass,
    valueRange: { min: 700, max: 900 },
    knownCount: 5,
    passCount: 2
  }
  const dataset: ShmooDataset = {
    id: 'ds',
    fileName: 'fixture.csv',
    filePath: null,
    importedAt: 0,
    kind: '2d',
    meta: {},
    title: 'FIXTURE',
    valueLabel: 'VOH',
    valueUnit: 'mV',
    xAxis: axis('VDD', [0.8, 0.9, 1.0]),
    yAxis: axis('PERIOD', [2.4, 2.5], 'ns'),
    sites: [site],
    valueType: 'measured',
    passSource: 'derived',
    spec: SPEC,
    issues: [],
    revision: 0
  }
  return { dataset, site }
}

describe('buildSliceSeries', () => {
  it('行切片：固定 y 扫 x，值顺序与横轴一致', () => {
    const { dataset, site } = makeFixture()
    const series = buildSliceSeries(dataset, site, { axis: 'row', index: 1 })
    expect(series).not.toBeNull()
    expect(Array.from(series!.value)).toEqual([800, 870, 900])
    expect(series!.axis.values).toEqual([0.8, 0.9, 1.0])
    expect(series!.fixedLabel).toBe('PERIOD = 2.5 ns')
    expect(series!.fixedValue).toBe(2.5)
    expect(series!.missing).toEqual([])
  })

  it('列切片：固定 x 扫 y，并把 y 轴改写成横轴（key=x）', () => {
    const { dataset, site } = makeFixture()
    const series = buildSliceSeries(dataset, site, { axis: 'col', index: 0 })
    expect(series).not.toBeNull()
    expect(Array.from(series!.value)).toEqual([700, 800])
    expect(series!.axis.key).toBe('x')
    expect(series!.axis.label).toBe('PERIOD')
    expect(series!.axis.values).toEqual([2.4, 2.5])
    expect(series!.fixedLabel).toBe('VDD = 0.8 V')
  })

  it('缺测点被记录下来，值保持 NaN（不插值）', () => {
    const { dataset, site } = makeFixture()
    const series = buildSliceSeries(dataset, site, { axis: 'row', index: 0 })!
    expect(series.missing).toEqual([2])
    expect(Number.isNaN(series.value[2])).toBe(true)
  })

  it('下标越界返回 null', () => {
    const { dataset, site } = makeFixture()
    expect(buildSliceSeries(dataset, site, { axis: 'row', index: 2 })).toBeNull()
    expect(buildSliceSeries(dataset, site, { axis: 'row', index: -1 })).toBeNull()
    expect(buildSliceSeries(dataset, site, { axis: 'col', index: 3 })).toBeNull()
  })

  it('1D 数据集没有可切的行列', () => {
    const { dataset, site } = makeFixture()
    const oneD: ShmooDataset = { ...dataset, kind: '1d', yAxis: null }
    expect(buildSliceSeries(oneD, site, { axis: 'row', index: 0 })).toBeNull()
  })
})

describe('buildSliceDataset', () => {
  it('包装成 kind=1d 的数据集，供同一个渲染路径消费', () => {
    const { dataset, site } = makeFixture()
    const view = buildSliceDataset(dataset, site, { axis: 'row', index: 0 })!
    expect(view.dataset.kind).toBe('1d')
    expect(view.dataset.yAxis).toBeNull()
    expect(view.dataset.id).toContain(':slice:row:0')
    expect(view.dataset.title).toContain('PERIOD = 2.4 ns')
    expect(view.dataset.sites).toHaveLength(1)
    expect(view.site.knownCount).toBe(2)
    expect(view.site.passCount).toBe(1)
    expect(view.site.valueRange).toEqual({ min: 700, max: 750 })
  })

  it('缺测格在切片里仍然是 UNKNOWN，不会变成 FAIL', () => {
    const { dataset, site } = makeFixture()
    const view = buildSliceDataset(dataset, site, { axis: 'row', index: 0 })!
    expect(view.site.pass[2]).toBe(CELL_UNKNOWN)
    expect(Number.isNaN(view.site.value[2])).toBe(true)
  })

  it('缺测点在 PASS 区间里形成断点（不跨过去连起来）', () => {
    const { dataset, site } = makeFixture()
    const view = buildSliceDataset(dataset, site, { axis: 'row', index: 0 })!
    const runs = findPassRuns(view.dataset.xAxis.values, view.site.pass)
    // 只有 750 一个点通过，右侧缺测把它截断，因此只有一段且长度为 0
    expect(runs).toHaveLength(1)
    expect(runs[0].count).toBe(1)
    expect(runs[0].startX).toBe(runs[0].endX)
  })
})

describe('worstMarginOfSeries', () => {
  it('取整条曲线里最小的 margin（越负越危险）', () => {
    const { dataset, site } = makeFixture()
    const series = buildSliceSeries(dataset, site, { axis: 'row', index: 1 })!
    // 800 → +20，870 → -10，900 → -40
    expect(worstMarginOfSeries(series, SPEC)).toBeCloseTo(-40, 5)
  })
})

describe('formatAxisValue', () => {
  it('小数位随轴步长变化，2.5 不会写成 2.50', () => {
    expect(formatAxisValue(2.5, [2.4, 2.5, 2.6])).toBe('2.5')
    expect(formatAxisValue(0.62, [0.6, 0.62, 0.64])).toBe('0.62')
    expect(formatAxisValue(900, [800, 900, 1000])).toBe('900')
  })
})

describe('切片状态（面包屑与回看定位）', () => {
  it('双击开切片 → 切列方向自动夹紧下标 → 返回 2D 后标记仍在', () => {
    const { dataset } = makeFixture()
    const store = useAppStore

    store.setState({ dataset, activeSiteId: 'S1', spec: SPEC, slice: null, sliceMarker: null })

    store.getState().openSlice({ axis: 'row', index: 1 })
    expect(store.getState().slice).toEqual({ axis: 'row', index: 1 })
    expect(store.getState().sliceMarker).toEqual({ axis: 'row', index: 1 })

    // 切到列方向：nx=3，原行号 1 仍然合法
    store.getState().setSliceAxis('col')
    expect(store.getState().slice).toEqual({ axis: 'col', index: 1 })

    // 越界行号被夹到末行（ny-1 = 1）
    store.getState().openSlice({ axis: 'row', index: 99 })
    expect(store.getState().slice).toEqual({ axis: 'row', index: 1 })

    store.getState().closeSlice()
    expect(store.getState().slice).toBeNull()
    expect(store.getState().sliceMarker).toEqual({ axis: 'row', index: 1 })

    store.getState().clearSliceMarker()
    expect(store.getState().sliceMarker).toBeNull()
  })

  it('换数据集会清空切片与标记，避免下标指向别的数据', () => {
    const { dataset } = makeFixture()
    const store = useAppStore
    store.setState({ dataset, activeSiteId: 'S1', spec: SPEC, slice: null, sliceMarker: null })
    store.getState().openSlice({ axis: 'row', index: 0 })
    expect(store.getState().slice).not.toBeNull()
    store.getState().setDataset(dataset)
    expect(store.getState().slice).toBeNull()
    expect(store.getState().sliceMarker).toBeNull()
  })
})
