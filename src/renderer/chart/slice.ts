import type { Axis, ShmooDataset, SiteGrid, SpecLimit, SpecSide } from '@shared/types/shmoo'
import { CELL_UNKNOWN } from '@shared/types/shmoo'
import { evaluatePoint } from '@shared/spec/evaluate'
import { tickDecimals } from './geometry'

/**
 * 2D → 1D 切片（阶段 ④ 追加）。
 *
 * 设计原则：切片不另写一套画法，而是把 2D 网格里的一行 / 一列“压平”成一个
 * 合法的 1D 数据集（kind='1d'、yAxis=null），再交给 Shmoo1DChart 走与原生 1D
 * 完全相同的渲染与判定路径。这样配色、刻度抽稀、窗口标注、缺测断线都自动一致。
 *
 * 本文件只做纯计算，不依赖 DOM，便于单测。
 */

/** 切片方向：row = 固定 y 扫 x（沿行），col = 固定 x 扫 y（沿列） */
export type SliceAxis = 'row' | 'col'

/** 一次切片引用：方向 + 被固定的那条线的下标 */
export interface SliceRef {
  axis: SliceAxis
  index: number
}

/** 切片后的一条 1D 序列 */
export interface SliceSeries {
  /** 横轴：行切片用原 x 轴；列切片把原 y 轴改写成横轴 */
  axis: Axis
  value: Float32Array
  pass: Uint8Array
  /** 被固定的那条线的名称与取值，用于面包屑（如 "PERIOD = 2.5 ns"） */
  fixedLabel: string
  fixedValue: number
  /** 缺失点的下标列表（测试与提示用） */
  missing: number[]
}

/** 把轴值格式化成人类可读的短文本；位数与轴的真实步长匹配（2.5 不会写成 2.50） */
export function formatAxisValue(value: number, values: number[]): string {
  return value.toFixed(tickDecimals(values))
}

/**
 * 取出一条切片序列。
 * 越界、非 2D 数据集、缺 y 轴时返回 null（调用方据此回退到原有视图）。
 */
export function buildSliceSeries(
  dataset: ShmooDataset,
  site: SiteGrid,
  ref: SliceRef
): SliceSeries | null {
  if (dataset.kind !== '2d' || !dataset.yAxis) return null
  const nx = dataset.xAxis.values.length
  const ny = dataset.yAxis.values.length

  if (ref.axis === 'row') {
    if (ref.index < 0 || ref.index >= ny) return null
    const value = new Float32Array(nx)
    const pass = new Uint8Array(nx)
    const missing: number[] = []
    for (let ix = 0; ix < nx; ix++) {
      const cell = ref.index * nx + ix
      value[ix] = site.value[cell]
      pass[ix] = site.pass[cell]
      if (!Number.isFinite(site.value[cell])) missing.push(ix)
    }
    return {
      axis: dataset.xAxis,
      value,
      pass,
      fixedLabel: `${dataset.yAxis.label} = ${formatAxisValue(dataset.yAxis.values[ref.index], dataset.yAxis.values)}${dataset.yAxis.unit ? ` ${dataset.yAxis.unit}` : ''}`,
      fixedValue: dataset.yAxis.values[ref.index],
      missing
    }
  }

  if (ref.index < 0 || ref.index >= nx) return null
  const value = new Float32Array(ny)
  const pass = new Uint8Array(ny)
  const missing: number[] = []
  for (let iy = 0; iy < ny; iy++) {
    const cell = iy * nx + ref.index
    value[iy] = site.value[cell]
    pass[iy] = site.pass[cell]
    if (!Number.isFinite(site.value[cell])) missing.push(iy)
  }
  // 列切片把 y 轴改写成横轴：key 必须是 'x'，否则渲染层的轴标题逻辑会误用 y 轴样式
  const axis: Axis = {
    key: 'x',
    label: dataset.yAxis.label,
    unit: dataset.yAxis.unit,
    values: dataset.yAxis.values,
    scale: dataset.yAxis.scale
  }
  return {
    axis,
    value,
    pass,
    fixedLabel: `${dataset.xAxis.label} = ${formatAxisValue(dataset.xAxis.values[ref.index], dataset.xAxis.values)}${dataset.xAxis.unit ? ` ${dataset.xAxis.unit}` : ''}`,
    fixedValue: dataset.xAxis.values[ref.index],
    missing
  }
}

/**
 * 把切片包装成一份 1D 数据集 + 站点。
 * id / title 都与父数据集区分开，避免 React 复用旧的入场动画状态。
 */
export function buildSliceDataset(
  parent: ShmooDataset,
  site: SiteGrid,
  ref: SliceRef
): { dataset: ShmooDataset; site: SiteGrid; series: SliceSeries } | null {
  const series = buildSliceSeries(parent, site, ref)
  if (!series) return null

  let knownCount = 0
  let passCount = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < series.value.length; i++) {
    const v = series.value[i]
    if (!Number.isFinite(v)) {
      // 缺失点必须保持 unknown，不能因为“切片”就变成失败
      series.pass[i] = CELL_UNKNOWN
      continue
    }
    knownCount += 1
    if (series.pass[i] === 1) passCount += 1
    if (v < min) min = v
    if (v > max) max = v
  }

  const sliceSite: SiteGrid = {
    siteId: site.siteId,
    siteLabel: site.siteLabel,
    value: series.value,
    pass: series.pass,
    valueRange: knownCount > 0 ? { min, max } : null,
    knownCount,
    passCount
  }

  const sliceDataset: ShmooDataset = {
    id: `${parent.id}:slice:${ref.axis}:${ref.index}`,
    fileName: parent.fileName,
    filePath: parent.filePath,
    importedAt: parent.importedAt,
    kind: '1d',
    meta: { ...parent.meta, sliceAxis: ref.axis, sliceIndex: String(ref.index) },
    title: `${parent.title} · ${series.fixedLabel}`,
    valueLabel: parent.valueLabel,
    valueUnit: parent.valueUnit,
    xAxis: series.axis,
    yAxis: null,
    sites: [sliceSite],
    valueType: parent.valueType,
    passSource: parent.passSource,
    spec: parent.spec,
    issues: parent.issues,
    revision: parent.revision
  }

  return { dataset: sliceDataset, site: sliceSite, series }
}

/** 切片上的最差 margin，以及它撞到的是哪一条边界 */
export interface SeriesWorstMargin {
  margin: number
  side: SpecSide | null
}

/**
 * 一条切片上最差的 margin（越负越危险）；没有可判定点时返回 null。
 * side 一并返回，供规格面板标注“撞上限 / 撞下限”。
 */
export function worstPointOfSeries(
  series: SliceSeries,
  spec: SpecLimit
): SeriesWorstMargin | null {
  let worst: SeriesWorstMargin | null = null
  for (let i = 0; i < series.value.length; i++) {
    const { margin, side } = evaluatePoint(series.value[i], spec)
    if (margin === null) continue
    if (worst === null || margin < worst.margin) worst = { margin, side }
  }
  return worst
}

/** 兼容旧调用：只取最差 margin 的数值 */
export function worstMarginOfSeries(series: SliceSeries, spec: SpecLimit): number | null {
  return worstPointOfSeries(series, spec)?.margin ?? null
}
