import type { ShmooDataset, SiteGrid, SpecLimit } from '@shared/types/shmoo'
import { CELL_PASS } from '@shared/types/shmoo'

/**
 * 1D Shmoo 的纯计算逻辑（无 DOM 依赖，便于单元测试）。
 *
 * 数据形态：一个站点、一条扫描轴（dataset.xAxis），每个 x 一个测量值。
 * 解析器把 1D 数据存成 nx × 1 的网格（yAxis 为 null），这里把它“压平”成序列。
 */

/** 一条连续的 PASS 区间（按采样点计） */
export interface PassRun {
  /** 起始 / 结束的采样下标（包含端点） */
  startIndex: number
  endIndex: number
  /** 区间边界的 x 值：直接取首末 PASS 采样点的扫描值，不做插值 */
  startX: number
  endX: number
  /** 窗口宽度 = endX - startX；单个 PASS 点时为 0 */
  width: number
  /** 区间内的 PASS 点数 */
  count: number
}

/** 1D 视图的纵轴刻度（值域，不是扫描轴） */
export interface ValueScale {
  min: number
  max: number
  ticks: number[]
}

/** 把数据集压平成 1D 序列；不是 1D 数据集时返回 null */
export function buildOneDSeries(
  dataset: ShmooDataset,
  site: SiteGrid
): { x: number[]; value: Float32Array; state: Uint8Array } | null {
  if (dataset.kind !== '1d') return null
  const x = dataset.xAxis.values
  if (x.length === 0) return null
  return { x, value: site.value, state: site.pass }
}

/**
 * 找出所有连续 PASS 区间。
 *
 * 规则：
 *  - 只有 CELL_PASS 参与；FAIL / UNKNOWN 都视为“断开”（缺失点不能算作通过）；
 *  - 相邻下标且状态为 PASS 的合并成一段；
 *  - 宽度按首末采样点的 x 差计算，是个保守的下界（真实穿越点在两个采样点之间，
 *    用采样点标边界可以保证报出的窗口一定落在实测通过范围内）。
 */
export function findPassRuns(x: number[], state: Uint8Array): PassRun[] {
  const runs: PassRun[] = []
  let start = -1
  const flush = (endExclusive: number): void => {
    if (start < 0) return
    const end = endExclusive - 1
    runs.push({
      startIndex: start,
      endIndex: end,
      startX: x[start],
      endX: x[end],
      width: x[end] - x[start],
      count: end - start + 1
    })
    start = -1
  }
  for (let i = 0; i < state.length; i++) {
    if (state[i] === CELL_PASS) {
      if (start < 0) start = i
    } else {
      flush(i)
    }
  }
  flush(state.length)
  return runs
}

/**
 * 主窗口：取跨度最大的一段（跨度相同时取点数更多的一段）。
 * 多条区间并存通常意味着中间有缺失/抖动，报告里只高亮最长的一条，
 * 其余区间仍会以颜色显示，不隐藏数据。
 */
export function pickPrimaryRun(runs: PassRun[]): PassRun | null {
  if (runs.length === 0) return null
  return runs.reduce((best, run) => {
    if (run.width > best.width) return run
    if (run.width === best.width && run.count > best.count) return run
    return best
  })
}

/**
 * 值域范围：实测值 + spec 上下限（保证 spec 线一定在可视范围内）。
 * tickCount 只是“希望出现几条刻度”的建议值，渲染层会按绘图区高度换算后再传进来：
 * 容器高时多给几条，避免出现「整张图只有 600/700/800 三根线」的空旷感。
 */
export function computeValueScale(
  values: Float32Array,
  spec: SpecLimit,
  tickCount = 6
): ValueScale | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let hasValue = false

  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    hasValue = true
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!hasValue) return null

  // spec 线也要纳入范围；否则限值在视野外，“越界”就看不出来了
  for (const bound of [spec.min, spec.max, spec.target]) {
    if (typeof bound === 'number' && Number.isFinite(bound)) {
      if (bound < min) min = bound
      if (bound > max) max = bound
    }
  }

  // 单值退化：人为撑开一点，避免除零
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.1)
    min -= pad
    max += pad
  } else {
    const pad = (max - min) * 0.06
    min -= pad
    max += pad
  }

  return { min, max, ticks: niceTicks(min, max, tickCount) }
}

/**
 * 生成“好看”的刻度：步长取 1 / 2 / 5 × 10^n。
 * 与几何层的 tickDecimals 配合，标签不会出现 0.30000000000000004 这类噪声。
 */
export function niceTicks(min: number, max: number, count = 6): number[] {
  const span = max - min
  if (!Number.isFinite(span) || span <= 0) return [min]
  const rawStep = span / Math.max(1, count - 1)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const normalized = rawStep / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  const step = factor * magnitude

  const ticks: number[] = []
  const start = Math.ceil(min / step - 1e-9) * step
  for (let v = start; v <= max + step * 1e-9; v += step) {
    // 去掉浮点尾差（例如 0.30000000000000004 → 0.3）
    ticks.push(Number(v.toPrecision(12)))
  }
  return ticks.length >= 2 ? ticks : [min, max]
}

/** 值 → 屏幕 y（值越大越靠上） */
export function valueToY(value: number, scale: ValueScale, top: number, height: number): number {
  const t = (value - scale.min) / (scale.max - scale.min)
  return top + (1 - t) * height
}

/** 按像素 x 找最近的采样下标（用于 hover 吸附） */
export function nearestSampleIndex(x: number[], pixelX: number, left: number, width: number): number {
  if (x.length === 0) return -1
  if (x.length === 1) return 0
  const span = x[x.length - 1] - x[0]
  const ratio = span === 0 ? 0 : (pixelX - left) / width
  const target = x[0] + Math.max(0, Math.min(1, ratio)) * span
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < x.length; i++) {
    const distance = Math.abs(x[i] - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}
