import type { Axis, SiteGrid } from '@shared/types/shmoo'
import { CELL_UNKNOWN } from '@shared/types/shmoo'
import {
  BINARY_PALETTES,
  CHART_STRUCTURE,
  type PaletteVariant,
  binaryMarginColor,
  binarySwatchStops,
  heatGradientStops,
  sampleHeatColor,
  valueToT
} from './colors'
import {
  type ChartGeometry,
  type CellIndex,
  cellCenter,
  cellRect,
  pickTickIndices,
  tickDecimals
} from './geometry'

/**
 * 2D Shmoo 的三层绘制实现（命令式 Canvas 2D，不含 React 状态）。
 *
 * 分层职责（对应执行计划 2.2 / 阶段 ③）：
 *  - staticLayer：背景 + 色块 + 网格线 + 坐标轴 + 图例 + 站点高亮框；
 *  - boundaryLayer：pass/fail 区域边界（只在二值模式、状态变化时重绘）；
 *  - interactionLayer：十字线 + hover 单元格描边，每帧只清这一层。
 *
 * 性能约束：30×30 = 900 个色块，全部用 fillRect，避免逐格路径与阴影；
 * 动画期间只对 static 层重绘，交互移动只重绘 interaction 层。
 */

export type ChartColorMode = 'binary' | 'heat'

/** 画布尺寸（CSS 像素）与设备像素比 */
export interface CanvasSize {
  width: number
  height: number
  dpr: number
}

/** 静态层 / 边界层共用的数据输入 */
export interface ChartDataInput {
  geometry: ChartGeometry
  xAxis: Axis
  yAxis: Axis
  site: SiteGrid
  valueLabel: string
  valueUnit: string
  mode: ChartColorMode
  /** 配色版本：A = 同源色板 + margin 明度调制，B = 降饱和 + 细描边 */
  variant: PaletteVariant
  /** 每个格子的 |margin| 归一化值（0–1）；null 表示无法计算，按 0.5 兜底 */
  tint: Float32Array | null
}

/** 入场动画参数（毫秒） */
export interface MotionInput {
  /** 是否播放动画；prefers-reduced-motion 时为 false */
  enabled: boolean
  /** 从左上到右下的延迟跨度 */
  delaySpan: number
  /** 单个色块的淡入时长 */
  cellDuration: number
  /** 动画已进行的时间（ms）；enabled=false 时忽略 */
  elapsed: number
}

/** 静态层绘制参数 */
export interface StaticLayerInput extends ChartDataInput {
  motion: MotionInput
}

/** 交互层绘制参数 */
export interface InteractionLayerInput {
  geometry: ChartGeometry
  hover: CellIndex | null
  /** 悬停格对应的值，用于在十字线端点显示读数（可选） */
  hoverValue?: string | null
}

/** 结构色字体：等宽，保证刻度数字宽度一致、不抖动 */
const FONT_MONO = '10px "Cascadia Mono", "JetBrains Mono", Consolas, monospace'
const FONT_MONO_SMALL = '9px "Cascadia Mono", "JetBrains Mono", Consolas, monospace'

/** 把 CSS 像素对齐到设备像素，避免 1px 缝隙与半像素模糊 */
function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr
}

/** easeOutCubic：入场用，前快后慢，观感“沉稳” */
function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return 1 - Math.pow(1 - clamped, 3)
}

/**
 * 计算单个色块在当前动画时刻的不透明度。
 * 对角线顺序：delay 与 (ix+iy) 成正比；动画关闭时恒为 1（瞬显）。
 */
export function cellAlpha(
  ix: number,
  iy: number,
  nx: number,
  ny: number,
  motion: MotionInput
): number {
  if (!motion.enabled) return 1
  const diagonal = nx + ny - 2
  const order = diagonal <= 0 ? 0 : (ix + iy) / diagonal
  const startedAt = order * motion.delaySpan
  if (motion.elapsed <= startedAt) return 0
  return easeOutCubic((motion.elapsed - startedAt) / motion.cellDuration)
}

/**
 * 在指定矩形内画 45° 斜纹（缺失点填充）。
 *
 * 为什么不用 CanvasPattern：pattern 的平铺原点落在设备像素网格上，
 * 在 DPR=2 时配合 setTransform 缩放会退化成稀疏点阵，看起来像噪点而非斜线。
 * 这里改为解析裁剪后直接描线：斜线方程 x + y = c，c 从 0 递增到 w + h，
 * 与矩形的交集用参数区间 [tStart, tEnd] 求出来，保证线条精确落在格子内部。
 */
export function drawCellHatch(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  w: number,
  h: number,
  step = 7
): void {
  if (w <= 2 || h <= 2) return
  ctx.strokeStyle = CHART_STRUCTURE.hatchStroke
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let c = step; c < w + h; c += step) {
    // 直线 x + y = c 与矩形 [0,w]×[0,h] 的交集参数区间
    const tStart = Math.max(0, c - h)
    const tEnd = Math.min(w, c)
    if (tEnd - tStart < 1) continue
    ctx.moveTo(left + tStart, top + c - tStart)
    ctx.lineTo(left + tEnd, top + c - tEnd)
  }
  ctx.stroke()
}

/** 绘制静态层：清屏 → 色块 → 网格线 → 边框 → 坐标轴 → 图例 */
export function drawStaticLayer(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const { geometry, site, mode, motion, variant, tint } = input
  const { plot } = geometry
  const { dpr, width, height } = size
  const palette = BINARY_PALETTES[variant]

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // 1. 画布底色：比面板更暗，让色块成为唯一视觉焦点
  ctx.fillStyle = CHART_STRUCTURE.canvasBg
  ctx.fillRect(0, 0, width, height)

  if (plot.w <= 2 || plot.h <= 2) return

  const nx = geometry.x.values.length
  const ny = geometry.y.values.length

  // 2. 色块（行优先：index = iy * nx + ix）
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const index = iy * nx + ix
      const value = site.value[index]
      const state = site.pass[index]
      const alpha = cellAlpha(ix, iy, nx, ny, motion)
      if (alpha <= 0.001) continue

      const rect = cellRect(geometry, ix, iy)
      // 四边都取整到设备像素，相邻色块共享同一条边界 → 不会出现发丝缝
      const left = snap(rect.x, dpr)
      const top = snap(rect.y, dpr)
      const right = snap(rect.x + rect.w, dpr)
      const bottom = snap(rect.y + rect.h, dpr)

      ctx.globalAlpha = alpha

      if (state === CELL_UNKNOWN || !Number.isFinite(value)) {
        // 缺失点：深底 + 45° 斜纹，表达“未测”而不是“失败”
        const w = right - left
        const h = bottom - top
        ctx.fillStyle = palette.unknownBase
        ctx.fillRect(left, top, w, h)
        drawCellHatch(ctx, left, top, w, h)
      } else if (mode === 'binary') {
        // A 版：明度随 |margin| 变化（贴近 spec 更暗，远离更亮）；
        // B 版：平坦降饱和色，层次交给描边与边界线
        const m = tint ? tint[index] : 0.5
        ctx.fillStyle = binaryMarginColor(variant, state, m)
        ctx.fillRect(left, top, right - left, bottom - top)
      } else {
        const t = valueToT(value, site.valueRange)
        ctx.fillStyle = sampleHeatColor(t, variant)
        ctx.fillRect(left, top, right - left, bottom - top)
      }
    }
  }
  ctx.globalAlpha = 1

  // 3. 单元格分隔线
  //    A 版：低对比网格线，只做“矩阵感”暗示；
  //    B 版：1 设备像素的深色描边，这是该版本表达格子边界的主要手段。
  ctx.strokeStyle = palette.cellOutline ?? CHART_STRUCTURE.gridLine
  ctx.lineWidth = palette.cellOutline ? 1 / dpr : 1
  ctx.beginPath()
  for (let ix = 0; ix <= nx; ix++) {
    const x = snap(geometry.x.edges[ix], dpr) + 0.5 / dpr
    ctx.moveTo(x, plot.y)
    ctx.lineTo(x, plot.y + plot.h)
  }
  for (let iy = 0; iy <= ny; iy++) {
    const y = snap(geometry.y.edges[iy], dpr) + 0.5 / dpr
    ctx.moveTo(plot.x, y)
    ctx.lineTo(plot.x + plot.w, y)
  }
  ctx.stroke()

  // 4. 数据区边框 + 当前站点高亮框（内缩 3px，青色细线，不抢色块）
  ctx.strokeStyle = CHART_STRUCTURE.axisLine
  ctx.strokeRect(snap(plot.x, dpr) + 0.5 / dpr, snap(plot.y, dpr) + 0.5 / dpr, plot.w, plot.h)
  ctx.strokeStyle = CHART_STRUCTURE.activeFrame
  ctx.strokeRect(
    snap(plot.x, dpr) + 3.5 / dpr,
    snap(plot.y, dpr) + 3.5 / dpr,
    plot.w - 7,
    plot.h - 7
  )

  // 5. 坐标轴（刻度对齐真实采样值）
  drawAxes(ctx, size, input)
  // 6. 图例
  drawLegend(ctx, size, input)
}

/** 坐标轴：轴线 + 刻度 + 抽稀标签 + 轴标题 */
function drawAxes(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const { geometry, xAxis, yAxis } = input
  const { plot } = geometry
  const { dpr, height } = size

  ctx.font = FONT_MONO
  ctx.textBaseline = 'middle'

  // ---- x 轴 ----
  // 刻度位置取“色块中心”，即真实采样值在像素上的位置（边界是中点，中心才是采样点）
  const xCenters = geometry.x.edges.slice(0, -1).map((edge, i) => {
    const rect = cellRect(geometry, i, 0)
    return edge + rect.w / 2
  })
  const xDecimals = tickDecimals(xAxis.values)
  // 抽稀依据：先量出最宽的一条刻度文字，再要求相邻标签中心距 >= 文字宽 + 16px 呼吸间距。
  // 这样点数增加（格子变窄）时会自动“隔几个标一个”，而不是把标签挤成一团；
  // 最小 36px 是为了避免 1–2 位数字时标签过密。
  const xLabelMaxWidth = xAxis.values.reduce(
    (max, value) => Math.max(max, ctx.measureText(value.toFixed(xDecimals)).width),
    0
  )
  const xIndices = pickTickIndices(xCenters, Math.max(36, xLabelMaxWidth + 16))

  ctx.strokeStyle = CHART_STRUCTURE.axisLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(plot.x, snap(plot.y + plot.h, dpr) + 0.5 / dpr)
  ctx.lineTo(plot.x + plot.w, snap(plot.y + plot.h, dpr) + 0.5 / dpr)
  ctx.stroke()

  ctx.fillStyle = CHART_STRUCTURE.tickText
  for (const i of xIndices) {
    const x = snap(xCenters[i], dpr)
    ctx.beginPath()
    ctx.moveTo(x + 0.5 / dpr, plot.y + plot.h)
    ctx.lineTo(x + 0.5 / dpr, plot.y + plot.h + 4)
    ctx.stroke()
    const text = xAxis.values[i].toFixed(xDecimals)
    // 首尾标签贴边对齐：宁可丢一点“居中对齐”的美观，也不让文字被画布裁掉或压到 y 轴标签上。
    // （100×100 这类格子只有几像素宽时，首末标签居中会各有一半跑出数据区）
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

  // x 轴标题（含单位），放在刻度下方
  ctx.font = FONT_MONO
  ctx.fillStyle = CHART_STRUCTURE.axisTitle
  ctx.textAlign = 'center'
  const xTitle = xAxis.unit ? `${xAxis.label} (${xAxis.unit})` : xAxis.label
  ctx.fillText(xTitle, plot.x + plot.w / 2, height - 10)

  // ---- y 轴 ----
  // 注意：几何上行索引 0 在底部，y 像素是递减的；而标签抽稀要求位置升序，
  // 所以这里先按屏幕坐标从上到下排序，再抽稀，最后用行索引取真实采样值。
  const yCenters = geometry.y.edges.slice(0, -1).map((edge, i) => {
    const rect = cellRect(geometry, 0, i)
    return edge + rect.h / 2
  })
  const yOrder = yCenters
    .map((y, iy) => ({ y, iy }))
    .sort((a, b) => a.y - b.y)
  const yIndices = pickTickIndices(
    yOrder.map((item) => item.y),
    28
  )

  // y 标签防裁剪：标签右对齐画在 plot.x - 8 处，可用宽度约 plot.x - 10。
  // 若最宽标签超出（例如 1e6 级大电流、或很长的电压值），先逐步减少小数位，
  // 减到 0 位仍放不下时换小一号字体。绝不截断数值，也不让文字画到画布外。
  // 抽稀只决定“标几个”，这里解决“单个标签是否放得下”，两件事互相独立。
  const yLabelSpace = plot.x - 10
  let yDecimals = tickDecimals(yAxis.values)
  let yLabels = yAxis.values.map((value) => value.toFixed(yDecimals))
  let yLabelMaxWidth = yLabels.reduce(
    (max, text) => Math.max(max, ctx.measureText(text).width),
    0
  )
  while (yDecimals > 0 && yLabelMaxWidth > yLabelSpace) {
    yDecimals--
    yLabels = yAxis.values.map((value) => value.toFixed(yDecimals))
    yLabelMaxWidth = yLabels.reduce(
      (max, text) => Math.max(max, ctx.measureText(text).width),
      0
    )
  }
  if (yLabelMaxWidth > yLabelSpace) {
    ctx.font = FONT_MONO_SMALL
  }

  ctx.beginPath()
  ctx.moveTo(snap(plot.x, dpr) + 0.5 / dpr, plot.y)
  ctx.lineTo(snap(plot.x, dpr) + 0.5 / dpr, plot.y + plot.h)
  ctx.stroke()

  ctx.fillStyle = CHART_STRUCTURE.tickText
  ctx.textAlign = 'right'
  for (const k of yIndices) {
    const { y, iy } = yOrder[k]
    const py = snap(y, dpr)
    ctx.beginPath()
    ctx.moveTo(plot.x - 4, py + 0.5 / dpr)
    ctx.lineTo(plot.x, py + 0.5 / dpr)
    ctx.stroke()
    ctx.fillText(yLabels[iy], plot.x - 8, py)
  }

  // y 轴标题：旋转 -90°，放在左侧留白中间
  ctx.font = FONT_MONO
  const yTitle = yAxis.unit ? `${yAxis.label} (${yAxis.unit})` : yAxis.label
  ctx.save()
  ctx.translate(14, plot.y + plot.h / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillStyle = CHART_STRUCTURE.axisTitle
  ctx.textAlign = 'center'
  ctx.fillText(yTitle, 0, 0)
  ctx.restore()
}

/** 图例：二值模式三块色卡；热力模式竖色带 + min/mid/max 刻度 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const { geometry, site, mode, valueLabel, valueUnit, variant } = input
  const { plot } = geometry
  const palette = BINARY_PALETTES[variant]
  const x0 = plot.x + plot.w + 18
  const y0 = plot.y + 4
  const width = size.width - x0 - 8
  if (width < 40) return

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  if (mode === 'binary') {
    ctx.font = FONT_MONO_SMALL
    ctx.fillStyle = CHART_STRUCTURE.legendMuted
    ctx.fillText('判定', x0, y0 + 6)

    const rows: Array<{ state: number; label: string; hatch?: boolean }> = [
      { state: 1, label: 'PASS' },
      { state: 0, label: 'FAIL' },
      { state: 2, label: 'NO DATA', hatch: true }
    ]
    rows.forEach((row, i) => {
      const y = y0 + 24 + i * 18
      if (row.hatch) {
        ctx.fillStyle = palette.unknownBase
        ctx.fillRect(x0, y - 5, 10, 10)
        // 与色块一致的斜纹示意：复用同一个描线函数，步长按 10px 小色卡缩小
        drawCellHatch(ctx, x0, y - 5, 10, 10, 4)
      } else if (palette.flat) {
        // B 版：平坦色块 + 与主图一致的 1 设备像素深色描边
        ctx.fillStyle = binaryMarginColor(variant, row.state, 1)
        ctx.fillRect(x0, y - 5, 10, 10)
        ctx.strokeStyle = palette.cellOutline ?? CHART_STRUCTURE.gridLine
        ctx.lineWidth = size.dpr > 1.5 ? 0.5 : 1
        ctx.strokeRect(x0 + 0.25, y - 4.75, 9.5, 9.5)
      } else {
        // A 版：色卡画成“暗端 → 锚点”的竖向渐变，与主图的 margin 明度调制同源
        const stops = binarySwatchStops(variant, row.state, 4)
        const stepH = 10 / stops.length
        stops.forEach((color, k) => {
          ctx.fillStyle = color
          // 从下往上：最暗在底部，对应贴近 spec 的格子
          ctx.fillRect(x0, y + 5 - (k + 1) * stepH, 10, Math.ceil(stepH))
        })
        ctx.strokeStyle = 'rgba(147, 166, 186, 0.22)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(x0 + 0.25, y - 4.75, 9.5, 9.5)
      }
      ctx.fillStyle = CHART_STRUCTURE.legendText
      ctx.font = FONT_MONO_SMALL
      ctx.fillText(row.label, x0 + 16, y)
    })

    // 说明图例的编码方式，避免把“亮 = 更结实”误读成“亮 = 更好/更差”
    ctx.fillStyle = CHART_STRUCTURE.legendMuted
    ctx.font = FONT_MONO_SMALL
    ctx.fillText(palette.flat ? '低饱和 + 细描边' : '明度 ∝ |margin|', x0, y0 + 24 + rows.length * 18 + 2)
    return
  }

  // ---- 热力模式 ----
  const range = site.valueRange
  const barHeight = Math.max(60, Math.min(140, plot.h - 96))
  const barTop = y0 + 26
  const barWidth = 10

  ctx.font = FONT_MONO_SMALL
  ctx.fillStyle = CHART_STRUCTURE.legendMuted
  ctx.fillText(valueUnit ? `${valueLabel} (${valueUnit})` : valueLabel, x0, y0 + 8)

  // 从下往上画：底部是最小值
  const steps = heatGradientStops(24, variant)
  const stepH = barHeight / steps.length
  steps.forEach((color, i) => {
    ctx.fillStyle = color
    const y = barTop + barHeight - (i + 1) * stepH
    ctx.fillRect(x0, y, barWidth, Math.ceil(stepH) + 0.5)
  })

  ctx.strokeStyle = CHART_STRUCTURE.axisLine
  ctx.strokeRect(x0, barTop, barWidth, barHeight)

  // 刻度：max / mid / min（等值退化时只显示一个值并提示）
  if (!range) {
    ctx.fillStyle = CHART_STRUCTURE.legendMuted
    ctx.fillText('无数据', x0, barTop + barHeight / 2)
    return
  }

  const decimals = tickDecimals([range.min, range.max])
  const isFlat = range.max === range.min
  const labelX = x0 + barWidth + 6
  ctx.fillStyle = CHART_STRUCTURE.legendText

  if (isFlat) {
    ctx.fillText(range.max.toFixed(decimals), labelX, barTop + barHeight / 2)
    ctx.fillStyle = CHART_STRUCTURE.legendMuted
    ctx.fillText('等值', labelX, barTop + barHeight / 2 + 14)
    return
  }

  ctx.fillText(range.max.toFixed(decimals), labelX, barTop + 4)
  ctx.fillText(
    ((range.min + range.max) / 2).toFixed(decimals),
    labelX,
    barTop + barHeight / 2
  )
  ctx.fillText(range.min.toFixed(decimals), labelX, barTop + barHeight - 4)
}

/**
 * 边界层：在 pass / fail 相邻处画线段，形成“阶梯状”通过区轮廓。
 * 只连接两种“已判定”状态，缺失点不参与，避免边界绕着一堆空洞抖动。
 */
export function drawBoundaryLayer(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const { geometry, site, mode, motion } = input
  const { dpr, width, height } = size
  const { plot } = geometry

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // 热力模式下色块本身已表达数值，边界只在二值模式显示，避免双重编码
  if (mode !== 'binary' || plot.w <= 2) return

  const nx = geometry.x.values.length
  const ny = geometry.y.values.length
  // 边界随色块一起淡入，略晚于最后一个色块出现，避免“框先于色块”
  const alpha = motion.enabled ? Math.min(1, Math.max(0, (motion.elapsed - motion.delaySpan) / 320)) : 1
  if (alpha <= 0) return

  const stateAt = (ix: number, iy: number): number => site.pass[iy * nx + ix]
  const known = (s: number) => s !== CELL_UNKNOWN

  ctx.strokeStyle = CHART_STRUCTURE.boundary
  ctx.globalAlpha = alpha
  ctx.lineWidth = 1
  ctx.beginPath()

  // 垂直边：左右相邻状态不同
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = stateAt(ix, iy)
      const b = stateAt(ix + 1, iy)
      if (!known(a) || !known(b) || a === b) continue
      const x = snap(geometry.x.edges[ix + 1], dpr) + 0.5 / dpr
      const rect = cellRect(geometry, ix, iy)
      ctx.moveTo(x, snap(rect.y, dpr))
      ctx.lineTo(x, snap(rect.y + rect.h, dpr))
    }
  }

  // 水平边：上下相邻状态不同
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = stateAt(ix, iy)
      const b = stateAt(ix, iy + 1)
      if (!known(a) || !known(b) || a === b) continue
      const y = snap(geometry.y.edges[iy + 1], dpr) + 0.5 / dpr
      const rect = cellRect(geometry, ix, iy)
      ctx.moveTo(snap(rect.x, dpr), y)
      ctx.lineTo(snap(rect.x + rect.w, dpr), y)
    }
  }

  ctx.stroke()
  ctx.globalAlpha = 1
}

/** 交互层：十字线 + hover 单元格描边；每帧全清（面积小，成本可忽略） */
export function drawInteractionLayer(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: InteractionLayerInput
): void {
  const { geometry, hover } = input
  const { dpr, width, height } = size
  const { plot } = geometry

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (!hover || plot.w <= 2) return

  const center = cellCenter(geometry, hover.ix, hover.iy)
  const cx = snap(center.x, dpr)
  const cy = snap(center.y, dpr)

  // 十字线：吸附到格子中心，虚线，低亮度
  ctx.strokeStyle = CHART_STRUCTURE.crosshair
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(cx + 0.5 / dpr, plot.y)
  ctx.lineTo(cx + 0.5 / dpr, plot.y + plot.h)
  ctx.moveTo(plot.x, cy + 0.5 / dpr)
  ctx.lineTo(plot.x + plot.w, cy + 0.5 / dpr)
  ctx.stroke()
  ctx.setLineDash([])

  // 当前格描边：亮青色，1.5px，略向外扩 0.5px 让色块本身完整露出
  const rect = cellRect(geometry, hover.ix, hover.iy)
  ctx.strokeStyle = CHART_STRUCTURE.hoverBorder
  ctx.lineWidth = 1.5
  ctx.strokeRect(
    snap(rect.x, dpr) - 0.75 / dpr,
    snap(rect.y, dpr) - 0.75 / dpr,
    snap(rect.x + rect.w, dpr) - snap(rect.x, dpr) + 1.5 / dpr,
    snap(rect.y + rect.h, dpr) - snap(rect.y, dpr) + 1.5 / dpr
  )
}
