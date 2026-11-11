import type { ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'
import {
  BINARY_PALETTE,
  CHART_STRUCTURE,
  binaryMarginColor,
  binarySwatchStops
} from './colors'
import {
  DEFAULT_PADDING,
  cellCenter,
  computeGeometry,
  pickTickIndices,
  tickDecimals
} from './geometry'
import type { CanvasSize } from './render2d'
import { drawCellHatch } from './render2d'
import { computeValueScale, findPassRuns, pickPrimaryRun, valueToY } from './oneD'
import type { PassRun, ValueScale } from './oneD'

/**
 * 1D Shmoo 绘制（Canvas 2D）。
 *
 * 两种形态：
 *  - band：二值色带。每个采样点一根竖直色条，颜色沿用 A′ 二值色板 + margin 明度调制，
 *    自动标出最长 PASS 区间的首末边界值与窗口宽度；
 *  - curve：连续曲线。叠加 spec 上下限两条虚线，越界点用红点 + 深色描边强调。
 *
 * 与 2D 共用：DEFAULT_PADDING 的绘图区、刻度抽稀策略、结构色、缺失斜纹、入场动效开关。
 * 这里不复用 2D 的 cellAlpha（它按行列做波浪展开）；1D 改用从左到右的水平揭示，
 * 更符合“扫描”语义。
 */

/** 1D 形态 */
export type OneDForm = 'band' | 'curve'

const FONT_MONO = '10px "Cascadia Mono", "JetBrains Mono", Consolas, monospace'
const FONT_MONO_SMALL = '9px "Cascadia Mono", "JetBrains Mono", Consolas, monospace'

/**
 * 色带高度：约占绘图区 34%，限制在 56–168px。
 * 1D 只有一行数据，色带太薄会在大画布上显得空，太厚又会像色块墙，这里取中间值。
 */
function bandHeight(plotHeight: number): number {
  return Math.max(56, Math.min(168, plotHeight * 0.34))
}

export interface OneDMotion {
  /** false 时直接画最终状态（prefers-reduced-motion / 非入场重绘） */
  enabled: boolean
  /** 入场总时长（ms） */
  duration: number
  /** 入场已进行的毫秒数 */
  elapsed: number
}

export interface OneDStaticInput {
  dataset: ShmooDataset
  site: SiteGrid
  form: OneDForm
  /** 每个采样点的 |margin| 归一化值；与 2D 共用同一套计算 */
  tint: Float32Array | null
  motion: OneDMotion
}

export interface OneDInteractionInput {
  dataset: ShmooDataset
  site: SiteGrid
  form: OneDForm
  /** hover 的采样下标；null 表示无交互 */
  index: number | null
}

/** 揭示进度（0–1）：入场时从左向右展开；未启用动效时恒为 1 */
function revealProgress(motion: OneDMotion): number {
  if (!motion.enabled || motion.duration <= 0) return 1
  const t = Math.max(0, Math.min(1, motion.elapsed / motion.duration))
  // easeOutCubic：起步快、收尾稳，和数据绘制动画的观感一致
  return 1 - Math.pow(1 - t, 3)
}

function snap(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr
}

/** x 轴（与 2D 相同的抽稀与首尾贴边策略） */
function drawXAxis(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  plot: { x: number; y: number; w: number; h: number },
  xValues: number[],
  xCenters: number[],
  axis: ShmooDataset['xAxis']
): void {
  const { dpr, height } = size
  ctx.font = FONT_MONO
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'

  const xDecimals = tickDecimals(xValues)
  const labelMaxWidth = xValues.reduce(
    (max, value) => Math.max(max, ctx.measureText(value.toFixed(xDecimals)).width),
    0
  )
  const indices = pickTickIndices(xCenters, Math.max(36, labelMaxWidth + 16))

  ctx.strokeStyle = CHART_STRUCTURE.axisLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(plot.x, snap(plot.y + plot.h, dpr) + 0.5 / dpr)
  ctx.lineTo(plot.x + plot.w, snap(plot.y + plot.h, dpr) + 0.5 / dpr)
  ctx.stroke()

  ctx.fillStyle = CHART_STRUCTURE.tickText
  for (const i of indices) {
    const x = snap(xCenters[i], dpr)
    ctx.beginPath()
    ctx.moveTo(x + 0.5 / dpr, plot.y + plot.h)
    ctx.lineTo(x + 0.5 / dpr, plot.y + plot.h + 4)
    ctx.stroke()

    const text = xValues[i].toFixed(xDecimals)
    const half = ctx.measureText(text).width / 2
    if (x - half < plot.x) {
      ctx.textAlign = 'left'
      ctx.fillText(text, plot.x, plot.y + plot.h + 14)
    } else if (x + half > plot.x + plot.w) {
      ctx.textAlign = 'right'
      ctx.fillText(text, plot.x + plot.w, plot.y + plot.h + 14)
    } else {
      ctx.textAlign = 'center'
      ctx.fillText(text, x, plot.y + plot.h + 14)
    }
  }

  ctx.fillStyle = CHART_STRUCTURE.axisTitle
  ctx.textAlign = 'center'
  const title = axis.unit ? `${axis.label} (${axis.unit})` : axis.label
  ctx.fillText(title, plot.x + plot.w / 2, height - 10)
}

/** 右侧图例（色带模式）：PASS / FAIL / NO DATA，明度含义与 2D 一致 */
function drawBinaryLegend(
  ctx: CanvasRenderingContext2D,
  plot: { x: number; y: number; w: number },
  rows: Array<{ label: string; state: number; hatch?: boolean }>
): void {
  const x0 = plot.x + plot.w + 18
  let y = plot.y + 10
  ctx.textBaseline = 'middle'
  ctx.font = FONT_MONO_SMALL

  for (const row of rows) {
    if (row.hatch) {
      ctx.fillStyle = BINARY_PALETTE.unknownBase
      ctx.fillRect(x0, y - 5, 10, 10)
      drawCellHatch(ctx, x0, y - 5, 10, 10, 4)
    } else {
      const stops = binarySwatchStops(row.state, 4)
      const stepH = 10 / stops.length
      stops.forEach((color, k) => {
        ctx.fillStyle = color
        ctx.fillRect(x0, y + 5 - (k + 1) * stepH, 10, Math.ceil(stepH))
      })
      ctx.strokeStyle = 'rgba(147, 166, 186, 0.22)'
      ctx.lineWidth = 0.5
      ctx.strokeRect(x0 + 0.25, y - 4.75, 9.5, 9.5)
    }
    ctx.fillStyle = CHART_STRUCTURE.legendText
    ctx.textAlign = 'left'
    ctx.fillText(row.label, x0 + 16, y)
    y += 18
  }

  ctx.fillStyle = CHART_STRUCTURE.legendMuted
  ctx.fillText('明度 ∝ |margin|', x0, y + 6)
}

/** 窗口标注文字：边界值 + 宽度，统一保留与 x 轴一致的小数位 */
function windowText(run: PassRun | null, xDecimals: number, unit: string): string {
  if (!run) return '无连续 PASS 区间'
  const suffix = unit ? ` ${unit}` : ''
  return `PASS 窗口 ${run.startX.toFixed(xDecimals)} – ${run.endX.toFixed(xDecimals)}${suffix} · 宽 ${run.width.toFixed(xDecimals)}${suffix}`
}

/**
 * 二值色带形态。
 * 布局：标题行（窗口信息）在绘图区顶部，色带垂直居中，边界虚线落到 x 轴。
 */
function drawBand(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  dataset: ShmooDataset,
  site: SiteGrid,
  tint: Float32Array | null,
  geometry: ReturnType<typeof computeGeometry>,
  reveal: number
): void {
  const { plot } = geometry
  const { dpr } = size
  const x = dataset.xAxis.values
  const nx = x.length
  const bandH = bandHeight(plot.h)
  const bandTop = plot.y + (plot.h - bandH) / 2
  const bandBottom = bandTop + bandH

  const xDecimals = tickDecimals(x)
  const runs = findPassRuns(x, site.pass)
  const primary = pickPrimaryRun(runs)

  // 1. 窗口信息：说明“这段色带里哪一截是通过的、边界在哪”
  ctx.font = FONT_MONO
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = CHART_STRUCTURE.axisTitle
  const more = runs.length > 1 ? `  · 另有 ${runs.length - 1} 段` : ''
  ctx.fillText(
    windowText(primary, xDecimals, dataset.xAxis.unit ?? '') + more,
    plot.x,
    plot.y + 12
  )

  // 2. 色带：逐点画竖条，颜色与 2D 二值模式完全同源
  const clipRight = plot.x + plot.w * reveal
  const centers: number[] = []
  for (let ix = 0; ix < nx; ix++) {
    const left = snap(geometry.x.edges[ix], dpr)
    const right = snap(geometry.x.edges[ix + 1], dpr)
    centers.push((left + right) / 2)
    if (left > clipRight) continue

    const index = ix
    const state = site.pass[index]
    const value = site.value[index]
    const drawRight = Math.min(right, clipRight)

    if (state === CELL_UNKNOWN || !Number.isFinite(value)) {
      ctx.fillStyle = BINARY_PALETTE.unknownBase
      ctx.fillRect(left, snap(bandTop, dpr), drawRight - left, snap(bandBottom, dpr) - snap(bandTop, dpr))
      drawCellHatch(ctx, left, snap(bandTop, dpr), drawRight - left, snap(bandBottom, dpr) - snap(bandTop, dpr))
    } else {
      const m = tint ? tint[index] : 0.5
      ctx.fillStyle = binaryMarginColor(state, m)
      ctx.fillRect(left, snap(bandTop, dpr), drawRight - left, snap(bandBottom, dpr) - snap(bandTop, dpr))
    }
  }

  // 3. 色带外框：上下两条细线，暗示这是“一条”数据带而不是独立矩形
  ctx.strokeStyle = 'rgba(147, 166, 186, 0.22)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(plot.x, snap(bandTop, dpr) + 0.5 / dpr)
  ctx.lineTo(plot.x + plot.w * reveal, snap(bandTop, dpr) + 0.5 / dpr)
  ctx.moveTo(plot.x, snap(bandBottom, dpr) + 0.5 / dpr)
  ctx.lineTo(plot.x + plot.w * reveal, snap(bandBottom, dpr) + 0.5 / dpr)
  ctx.stroke()

  // 4. 边界：最长 PASS 区间的首末采样点，虚线落到 x 轴，值标在色带上方
  ctx.font = FONT_MONO_SMALL
  ctx.textAlign = 'center'
  // 注意：上一段逐格填充留下了红色 fillStyle，这里必须显式改回刻度文字色，否则标签会被染成红色
  ctx.fillStyle = CHART_STRUCTURE.tickText
  if (primary) {
    const boundaries = [
      { value: primary.startX, index: primary.startIndex, align: 'start' as const },
      { value: primary.endX, index: primary.endIndex, align: 'end' as const }
    ]
    for (const boundary of boundaries) {
      const bx = snap(centers[boundary.index] ?? plot.x, dpr)
      if (bx > clipRight) continue
      ctx.strokeStyle = 'rgba(230, 238, 247, 0.55)'
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(bx + 0.5 / dpr, snap(bandTop, dpr) - 6)
      ctx.lineTo(bx + 0.5 / dpr, plot.y + plot.h)
      ctx.stroke()
      ctx.setLineDash([])

      const label = boundary.value.toFixed(xDecimals)
      const half = ctx.measureText(label).width / 2
      // 贴边时改成左/右对齐，避免边界值被裁掉
      if (bx - half < plot.x) {
        ctx.textAlign = 'left'
        ctx.fillText(label, plot.x, bandTop - 14)
      } else if (bx + half > plot.x + plot.w) {
        ctx.textAlign = 'right'
        ctx.fillText(label, plot.x + plot.w, bandTop - 14)
      } else {
        ctx.textAlign = 'center'
        ctx.fillText(label, bx, bandTop - 14)
      }
    }
  }

  // 5. 图例
  drawBinaryLegend(ctx, plot, [
    { label: 'PASS', state: CELL_PASS },
    { label: 'FAIL', state: CELL_FAIL },
    { label: 'NO DATA', state: CELL_UNKNOWN, hatch: true }
  ])
}

/**
 * spec 限值标签：在曲线之后画，保证不被数据压住。
 *
 * 位置固定在绘图区左侧：曲线右端常常正好落在限值附近，标签放右侧会和越界点打架。
 * 默认压在线上方；若太靠近顶部（窗口说明文字），则翻到线下方。
 * 文字底垫半透明底色，压到网格或曲线上也能读清。
 */
function drawSpecLabels(
  ctx: CanvasRenderingContext2D,
  plot: { x: number; y: number; w: number; h: number },
  scale: ValueScale,
  spec: ShmooDataset['spec'],
  dpr: number,
  safeTop: number
): void {
  ctx.font = FONT_MONO_SMALL
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  const rows: Array<{ value: number; label: string }> = []
  if (typeof spec.max === 'number') rows.push({ value: spec.max, label: `SPEC MAX ${spec.max}` })
  if (typeof spec.min === 'number') rows.push({ value: spec.min, label: `SPEC MIN ${spec.min}` })

  for (const row of rows) {
    const py = snap(valueToY(row.value, scale, plot.y, plot.h), dpr)
    const above = py - 10
    const y = above >= safeTop ? above : Math.min(py + 10, plot.y + plot.h - 8)
    const width = ctx.measureText(row.label).width
    ctx.fillStyle = 'rgba(7, 10, 15, 0.72)'
    ctx.fillRect(plot.x + 3, y - 7, width + 8, 14)
    ctx.fillStyle = CHART_STRUCTURE.legendText
    ctx.fillText(row.label, plot.x + 7, y)
  }
}

/** 连续曲线形态 */
function drawCurve(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  dataset: ShmooDataset,
  site: SiteGrid,
  geometry: ReturnType<typeof computeGeometry>,
  scale: ValueScale,
  reveal: number
): void {
  const { plot } = geometry
  const { dpr } = size
  const x = dataset.xAxis.values
  const values = site.value
  const nx = x.length
  const yDecimals = tickDecimals(scale.ticks)
  const yTicks = scale.ticks

  // 1. 横向网格 + y 刻度
  ctx.font = FONT_MONO
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = 'rgba(51, 70, 90, 0.28)'
  ctx.lineWidth = 1
  for (const tick of yTicks) {
    const py = snap(valueToY(tick, scale, plot.y, plot.h), dpr)
    ctx.beginPath()
    ctx.moveTo(plot.x, py + 0.5 / dpr)
    ctx.lineTo(plot.x + plot.w, py + 0.5 / dpr)
    ctx.stroke()
  }
  ctx.fillStyle = CHART_STRUCTURE.tickText
  ctx.textAlign = 'right'
  for (const tick of yTicks) {
    const py = snap(valueToY(tick, scale, plot.y, plot.h), dpr)
    ctx.beginPath()
    ctx.moveTo(plot.x - 4, py + 0.5 / dpr)
    ctx.lineTo(plot.x, py + 0.5 / dpr)
    ctx.stroke()
    ctx.fillText(tick.toFixed(yDecimals), plot.x - 8, py)
  }

  // y 轴标题
  ctx.save()
  ctx.translate(14, plot.y + plot.h / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.font = FONT_MONO
  ctx.fillStyle = CHART_STRUCTURE.axisTitle
  ctx.textAlign = 'center'
  const yTitle = dataset.valueUnit
    ? `${dataset.valueLabel} (${dataset.valueUnit})`
    : dataset.valueLabel
  ctx.fillText(yTitle, 0, 0)
  ctx.restore()

  ctx.strokeStyle = CHART_STRUCTURE.axisLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(snap(plot.x, dpr) + 0.5 / dpr, plot.y)
  ctx.lineTo(snap(plot.x, dpr) + 0.5 / dpr, plot.y + plot.h)
  ctx.stroke()

  // 2. spec 区域：上限以上、下限以下铺极淡的红，先让人看到“哪里是禁区”
  const spec = dataset.spec
  if (typeof spec.max === 'number') {
    const py = valueToY(spec.max, scale, plot.y, plot.h)
    ctx.fillStyle = 'rgba(192, 69, 62, 0.07)'
    ctx.fillRect(plot.x, plot.y, plot.w, Math.max(0, py - plot.y))
  }
  if (typeof spec.min === 'number') {
    const py = valueToY(spec.min, scale, plot.y, plot.h)
    ctx.fillStyle = 'rgba(192, 69, 62, 0.07)'
    ctx.fillRect(plot.x, py, plot.w, Math.max(0, plot.y + plot.h - py))
  }

  // 3. spec 线：中性白 + 虚线，不用红色，避免与“越界点”抢语义
  //    标签单独放到曲线之后画（见下方 drawSpecLabels），否则会被曲线和数据点压住
  ctx.font = FONT_MONO_SMALL
  const drawSpecLine = (value: number): void => {
    const py = snap(valueToY(value, scale, plot.y, plot.h), dpr)
    ctx.strokeStyle = 'rgba(230, 238, 247, 0.55)'
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(plot.x, py + 0.5 / dpr)
    ctx.lineTo(plot.x + plot.w, py + 0.5 / dpr)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (typeof spec.max === 'number') drawSpecLine(spec.max)
  if (typeof spec.min === 'number') drawSpecLine(spec.min)
  if (typeof spec.target === 'number') {
    const py = snap(valueToY(spec.target, scale, plot.y, plot.h), dpr)
    ctx.strokeStyle = 'rgba(56, 207, 224, 0.28)'
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    ctx.moveTo(plot.x, py + 0.5 / dpr)
    ctx.lineTo(plot.x + plot.w, py + 0.5 / dpr)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 4. 面积淡填充 + 曲线：按连续有效段拆分，缺失点处断开
  const px: number[] = []
  for (let ix = 0; ix < nx; ix++) px.push(cellCenter(geometry, ix, 0).x)
  const segments: Array<Array<{ x: number; y: number }>> = []
  let current: Array<{ x: number; y: number }> = []
  for (let ix = 0; ix < nx; ix++) {
    const v = values[ix]
    if (!Number.isFinite(v)) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    current.push({ x: px[ix], y: valueToY(v, scale, plot.y, plot.h) })
  }
  if (current.length > 0) segments.push(current)

  ctx.save()
  ctx.beginPath()
  ctx.rect(plot.x, plot.y, plot.w * reveal, plot.h)
  ctx.clip()

  for (const segment of segments) {
    if (segment.length < 2) continue
    ctx.beginPath()
    ctx.moveTo(segment[0].x, plot.y + plot.h)
    for (const point of segment) ctx.lineTo(point.x, point.y)
    ctx.lineTo(segment[segment.length - 1].x, plot.y + plot.h)
    ctx.closePath()
    ctx.fillStyle = 'rgba(38, 150, 138, 0.10)'
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(segment[0].x, segment[0].y)
    for (let i = 1; i < segment.length; i++) ctx.lineTo(segment[i].x, segment[i].y)
    ctx.strokeStyle = '#7fd3c6'
    ctx.lineWidth = 1.6
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  // 5. 采样点：点数少时全画；点数多时只保留越界点，避免糊成一条粗线
  const drawAllPoints = nx <= 60
  for (let ix = 0; ix < nx; ix++) {
    const v = values[ix]
    if (!Number.isFinite(v)) continue
    const state = site.pass[ix]
    if (state !== CELL_FAIL && !drawAllPoints) continue
    const cx = px[ix]
    const cy = valueToY(v, scale, plot.y, plot.h)
    if (state === CELL_FAIL) {
      // 越界点：深色底环 + 红点，即使叠在红带上也能看清
      ctx.beginPath()
      ctx.arc(cx, cy, 4.2, 0, Math.PI * 2)
      ctx.fillStyle = '#0a0f16'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(cx, cy, 2.9, 0, Math.PI * 2)
      ctx.fillStyle = BINARY_PALETTE.failAnchor
      ctx.fill()
      ctx.strokeStyle = '#ff8b84'
      ctx.lineWidth = 0.9
      ctx.stroke()
    } else if (state === CELL_PASS) {
      ctx.beginPath()
      ctx.arc(cx, cy, 2.1, 0, Math.PI * 2)
      ctx.fillStyle = BINARY_PALETTE.passAnchor
      ctx.fill()
    }
  }
  ctx.restore()

  // 6. spec 标签：放在曲线之后画，避免被曲线/数据点压住
  drawSpecLabels(ctx, plot, scale, spec, dpr, plot.y + 26)

  // 7. 窗口信息与图例
  const xDecimals = tickDecimals(x)
  const runs = findPassRuns(x, site.pass)
  const primary = pickPrimaryRun(runs)
  ctx.font = FONT_MONO
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = CHART_STRUCTURE.axisTitle
  ctx.fillText(windowText(primary, xDecimals, dataset.xAxis.unit ?? ''), plot.x, plot.y + 12)

  const x0 = plot.x + plot.w + 18
  let y = plot.y + 10
  ctx.font = FONT_MONO_SMALL
  ctx.strokeStyle = '#7fd3c6'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(x0, y)
  ctx.lineTo(x0 + 10, y)
  ctx.stroke()
  ctx.fillStyle = CHART_STRUCTURE.legendText
  ctx.textAlign = 'left'
  ctx.fillText('实测值', x0 + 16, y)

  y += 18
  ctx.beginPath()
  ctx.arc(x0 + 5, y, 2.1, 0, Math.PI * 2)
  ctx.fillStyle = BINARY_PALETTE.passAnchor
  ctx.fill()
  ctx.fillText('合格点', x0 + 16, y)

  y += 18
  ctx.beginPath()
  ctx.arc(x0 + 5, y, 3, 0, Math.PI * 2)
  ctx.fillStyle = BINARY_PALETTE.failAnchor
  ctx.fill()
  ctx.fillText('越界点', x0 + 16, y)

  y += 18
  ctx.strokeStyle = 'rgba(230, 238, 247, 0.55)'
  ctx.lineWidth = 1
  ctx.setLineDash([5, 4])
  ctx.beginPath()
  ctx.moveTo(x0, y)
  ctx.lineTo(x0 + 10, y)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = CHART_STRUCTURE.legendMuted
  ctx.fillText('SPEC 限值', x0 + 16, y)
}

/** 静态层：底色 → 内容 → 轴 → 图例 */
export function drawOneDStatic(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: OneDStaticInput
): void {
  const { dataset, site, form, tint, motion } = input
  const { width, height, dpr } = size

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = CHART_STRUCTURE.canvasBg
  ctx.fillRect(0, 0, width, height)

  const x = dataset.xAxis.values
  if (x.length === 0) return

  // y 轴传一个占位值：1D 只借用 x 轴的边界/中心计算，plot 尺寸与 2D 完全一致
  const geometry = computeGeometry(width, height, DEFAULT_PADDING, x, [0])
  const { plot } = geometry
  if (plot.w <= 2 || plot.h <= 2) return

  ctx.fillStyle = CHART_STRUCTURE.plotBg
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h)
  ctx.strokeStyle = CHART_STRUCTURE.activeFrame
  ctx.lineWidth = 1
  ctx.strokeRect(
    snap(plot.x, dpr) + 0.5 / dpr,
    snap(plot.y, dpr) + 0.5 / dpr,
    plot.w,
    plot.h
  )

  const reveal = revealProgress(motion)
  const xCenters = x.map((_, ix) => cellCenter(geometry, ix, 0).x)

  if (form === 'band') {
    drawBand(ctx, size, dataset, site, tint, geometry, reveal)
  } else {
    // 刻度密度跟着绘图区高度走：高容器多给几条，矮容器少给几条，避免出现大片空白
    const tickCount = Math.max(4, Math.min(10, Math.round(plot.h / 70)))
    const scale = computeValueScale(site.value, dataset.spec, tickCount)
    if (scale) {
      drawCurve(ctx, size, dataset, site, geometry, scale, reveal)
    } else {
      ctx.font = FONT_MONO
      ctx.fillStyle = CHART_STRUCTURE.legendMuted
      ctx.textAlign = 'center'
      ctx.fillText('无有效测量值', plot.x + plot.w / 2, plot.y + plot.h / 2)
    }
  }

  drawXAxis(ctx, size, plot, x, xCenters, dataset.xAxis)
}

/** 交互层：竖线吸附 + 当前点圈选（tooltip 由 React 组件绘制） */
export function drawOneDInteraction(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: OneDInteractionInput
): void {
  const { dataset, site, form, index } = input
  const { width, height, dpr } = size

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (index === null || index < 0) return

  const x = dataset.xAxis.values
  if (index >= x.length) return

  const geometry = computeGeometry(width, height, DEFAULT_PADDING, x, [0])
  const { plot } = geometry
  if (plot.w <= 2 || plot.h <= 2) return

  const cx = snap(cellCenter(geometry, index, 0).x, dpr)
  ctx.strokeStyle = CHART_STRUCTURE.crosshair
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(cx + 0.5 / dpr, plot.y)
  ctx.lineTo(cx + 0.5 / dpr, plot.y + plot.h)
  ctx.stroke()
  ctx.setLineDash([])

  // 曲线模式额外圈出当前采样点；色带模式只显示竖线（带子本身就是“点”）
  if (form === 'curve') {
    const scale = computeValueScale(site.value, dataset.spec)
    const value = site.value[index]
    if (scale && Number.isFinite(value)) {
      const cy = snap(valueToY(value, scale, plot.y, plot.h), dpr)
      ctx.beginPath()
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2)
      ctx.strokeStyle = CHART_STRUCTURE.hoverBorder
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  } else {
    // 色带模式：把当前采样点所在的竖条描出来
    const left = snap(geometry.x.edges[index], dpr)
    const right = snap(geometry.x.edges[index + 1], dpr)
    const bandH = bandHeight(plot.h)
    const bandTop = plot.y + (plot.h - bandH) / 2
    ctx.strokeStyle = CHART_STRUCTURE.hoverBorder
    ctx.lineWidth = 1.5
    ctx.strokeRect(left, snap(bandTop, dpr), right - left, snap(bandH, dpr))
  }
}
