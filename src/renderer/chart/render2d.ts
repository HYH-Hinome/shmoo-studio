import type { Axis, SiteGrid } from '@shared/types/shmoo'
import { CELL_UNKNOWN } from '@shared/types/shmoo'
import {
  BINARY_PALETTE,
  CHART_STRUCTURE,
  PASSFAIL_PALETTE,
  binaryMarginColor,
  binarySwatchStops,
  heatGradientStops,
  passFailColor,
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
 * 分层职责：
 *  - staticLayer：背景（含 vignette）→ 圆角色块 → 噪点纹理 → 数据区边框
 *    → 切片标记 → 坐标轴 → 图例；
 *  - boundaryLayer：pass/fail 阶梯边界 + 可选的氛围动效；
 *  - interactionLayer：十字准线 + hover 格描边 + 涟漪，每帧只清这一层。
 *
 * 视觉方向（圆角单元格）：
 *  - 每格是圆角矩形，格间留 1 逻辑像素缝，露出画布底色形成细网格；
 *  - 圆角半径随格子尺寸自适应（见 CELL_RADIUS_RATIO / cellCornerRadius），
 *    30×30 时圆角明显，100×100 时收成近方角，不会糊成圆点；
 *  - 格子足够大时叠一条极淡的顶部高光，制造很轻的立体感（不做拟物按钮）。
 *
 * 性能约束：
 *  - 静态层只在数据/尺寸/配色变化时重绘，默认状态完全静止；
 *  - 每格一次 roundRect + fill，未知格另加斜纹；
 *  - 边界层与交互层都很轻，氛围动效只重绘边界层并降帧。
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
  /**
   * 是否为纯二值数据集（组件层 useMemo 一次判定，见 isFlatBinaryDataset）：
   *  - false（默认）：连续测量值，二值模式用 margin 明度调制；
   *  - true：0/1 pattern 或 passfail 数据，没有连续量，改用饱和平涂系统色。
   */
  flatBinary?: boolean
  /** 每个格子的 |margin| 归一化值（0–1）；null 表示无法计算，按 0.5 兜底 */
  tint: Float32Array | null
}

/** 入场动画参数（毫秒） */
export interface MotionInput {
  /** 是否播放动画；prefers-reduced-motion 时为 false */
  enabled: boolean
  /** 动画已进行的时间（ms）；enabled=false 时忽略 */
  elapsed: number
}

/** 静态层绘制参数 */
export interface StaticLayerInput extends ChartDataInput {
  motion: MotionInput
  /**
   * 切片标记：从切片视图返回 2D 后仍然保留，提示“刚才看的是这一行/列”。
   * 只画虚线框 + 极淡提亮，不改变色块本身的读数。
   */
  sliceMarker?: { axis: 'row' | 'col'; index: number } | null
}

/** hover 涟漪参数：从命中点扩散、快速衰减、不留残影 */
export interface RippleInput {
  x: number
  y: number
  /** 已进行的毫秒数；>= 300 时视为结束 */
  elapsed: number
}

/** 交互层绘制参数 */
export interface InteractionLayerInput {
  geometry: ChartGeometry
  hover: CellIndex | null
  /**
   * 悬停所在的行号：整行铺一层很淡的白色，暗示“双击这一行可以切片”。
   * 只提示、不抢注意力，因此透明度固定 8%，不做动画。
   */
  hoverRow?: number | null
  /** 悬停格对应的值，用于在十字线端点显示读数（可选） */
  hoverValue?: string | null
  /** hover 涟漪；null/缺省表示不画（reduced-motion 或未移动） */
  ripple?: RippleInput | null
}

/** 氛围动效参数：只有用户打开开关才传入 */
export interface AmbientInput {
  /** 相位（弧度）；由 rAF 循环推进，约 4s 一个周期 */
  phase: number
  /** 噪声纹理偏移量（像素），让轮廓噪声缓慢流动 */
  drift: number
}

/** 结构色字体：JetBrains Mono 打包在仓库内（OFL），不依赖系统字体 */
const FONT_MONO = '10px "JetBrains Mono", "Cascadia Mono", Consolas, monospace'
const FONT_MONO_SMALL = '9px "JetBrains Mono", "Cascadia Mono", Consolas, monospace'

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

/** 入场：按到图心距离分 6 层，每层间隔 30ms，同层批量点亮 */
export const ENTRANCE_LAYER_COUNT = 6
export const ENTRANCE_LAYER_DELAY = 30
const ENTRANCE_LAYER_DURATION = 240
/** 入场总时长：最后一层的开始时间 + 淡入时长，用于收尾与边界层延时 */
export const ENTRANCE_TOTAL =
  (ENTRANCE_LAYER_COUNT - 1) * ENTRANCE_LAYER_DELAY + ENTRANCE_LAYER_DURATION

/**
 * 计算单个色块在当前动画时刻的不透明度。
 *
 * 分层口径：把“到网格中心的归一化距离”均分成 6 层，同层格子同时亮起。
 * 为什么不做逐格串行：100×100 时逐格延迟会让总时长失控；分层后总时长恒定约 390ms，
 * 且视觉上是从中心向外一圈圈点亮，符合“仪器扫描”的感觉。
 * 动画关闭（prefers-reduced-motion 或首帧前）时恒为 1，静态首帧即最终画面。
 */
export function cellAlpha(
  ix: number,
  iy: number,
  nx: number,
  ny: number,
  motion: MotionInput
): number {
  if (!motion.enabled) return 1
  // 单格网格没有“距离”可言，直接归到第 0 层
  const halfX = (nx - 1) / 2
  const halfY = (ny - 1) / 2
  const maxDist = Math.hypot(halfX, halfY)
  const distance = maxDist > 0 ? Math.hypot(ix - halfX, iy - halfY) / maxDist : 0
  const layer = Math.min(ENTRANCE_LAYER_COUNT - 1, Math.floor(distance * ENTRANCE_LAYER_COUNT))
  const startedAt = layer * ENTRANCE_LAYER_DELAY
  if (motion.elapsed <= startedAt) return 0
  return easeOutCubic((motion.elapsed - startedAt) / ENTRANCE_LAYER_DURATION)
}

/** 格间缝隙：1 逻辑像素（DPR=2 时正好 2 设备像素），缝里露出画布底色形成细网格 */
export const CELL_GAP = 1
/** 圆角半径占短边的比例 */
export const CELL_RADIUS_RATIO = 0.18
/** 圆角上下限（逻辑像素）：太大格会变胶囊，太小格会糊成圆点 */
export const CELL_RADIUS_MIN = 1.5
export const CELL_RADIUS_MAX = 5

/**
 * 自适应圆角半径。
 *
 * 半径按“去掉缝隙后的短边”计算，并夹到 1.5–5：
 *  - 30×30（短边约 23px）→ 约 4.1px，圆角明显、有 iOS 卡片的观感；
 *  - 100×100（短边约 6.5px）→ 理论值 1.17px，夹到 1.5px，趋向小圆角，不会糊成圆点。
 */
export function cellCornerRadius(innerW: number, innerH: number): number {
  const short = Math.min(innerW, innerH)
  if (!Number.isFinite(short) || short <= 0) return 0
  return Math.max(CELL_RADIUS_MIN, Math.min(CELL_RADIUS_MAX, short * CELL_RADIUS_RATIO))
}

/** 顶部高光的最小短边要求：格子太小时高光不足 1px，画了也只会发灰，直接跳过 */
const HIGHLIGHT_MIN_SHORT = 7

/**
 * 极淡径向 vignette（最大 1.2%）。
 * 只作用于背景层：必须在色块之前绘制，否则中心与边缘的同色格子观感不一致，会误导判读。
 */
function drawVignette(ctx: CanvasRenderingContext2D, geometry: ChartGeometry): void {
  const { plot } = geometry
  const cx = plot.x + plot.w / 2
  const cy = plot.y + plot.h / 2
  const radius = Math.hypot(plot.w, plot.h) / 2
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.25, cx, cy, radius)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
  gradient.addColorStop(1, CHART_STRUCTURE.vignette)
  ctx.fillStyle = gradient
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h)
}

/** 噪点纹理缓存：一次生成 96×96 的白色低透明噪点，重复平铺 */
let noiseTile: HTMLCanvasElement | null = null
const noisePatternCache = new WeakMap<CanvasRenderingContext2D, CanvasPattern>()

/** 生成（或复用）噪点纹理画布 */
function getNoiseTile(): HTMLCanvasElement | null {
  if (noiseTile) return noiseTile
  if (typeof document === 'undefined') return null
  const tile = document.createElement('canvas')
  tile.width = 96
  tile.height = 96
  const tileCtx = tile.getContext('2d')
  if (!tileCtx) return null
  const image = tileCtx.createImageData(96, 96)
  // 固定 LCG 种子：噪点纹理每次运行一致，截图可复现
  let seed = 20261111
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const alpha = (seed >>> 24) % 18 // 0..17，平均约 3.5%，视觉上接近 2%
    image.data[i] = 255
    image.data[i + 1] = 255
    image.data[i + 2] = 255
    image.data[i + 3] = alpha
  }
  tileCtx.putImageData(image, 0, 0)
  noiseTile = tile
  return tile
}

/** 取噪点 pattern（按 ctx 缓存，避免每帧 createPattern） */
function getNoisePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const cached = noisePatternCache.get(ctx)
  if (cached) return cached
  const tile = getNoiseTile()
  if (!tile) return null
  const pattern = ctx.createPattern(tile, 'repeat')
  if (pattern) noisePatternCache.set(ctx, pattern)
  return pattern
}

/** 在数据区叠加约 2% 的噪点纹理（对色块与背景一视同仁，不改变色相） */
function drawNoiseOverlay(ctx: CanvasRenderingContext2D, geometry: ChartGeometry, alpha = 1): void {
  const pattern = getNoisePattern(ctx)
  if (!pattern) return
  const { plot } = geometry
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = pattern
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h)
  ctx.restore()
}

/**
 * 圆角单元格：每格是一个圆角矩形，格间留 1px 缝露出画布底色。
 *
 * 统一用于二值与热力两种配色：
 *  1. 圆角半径按格子的实际短边自适应（100×100 时自动收紧，不会糊成圆点）；
 *  2. 二值模式保留 margin 明度调制（越贴 spec 越暗），热力模式用连续色带；
 *  3. 缺失格换成深底 + 45° 斜纹，表达“未测”而不是“失败”；
 *  4. 格子足够大时，在顶部内侧叠一条 1 设备像素的白线（约 5%），
 *     只是让平涂有一点受光感，不做内阴影/渐变，避免变成拟物按钮。
 */
function drawCells(ctx: CanvasRenderingContext2D, size: CanvasSize, input: StaticLayerInput): void {
  const { geometry, site, mode, motion, tint } = input
  const { dpr } = size
  const nx = geometry.x.values.length
  const ny = geometry.y.values.length
  const halfGap = CELL_GAP / 2
  // 直接读几何边界数组，省掉每格一次 cellRect 对象分配（100×100 时是 1 万次）。
  // 注意必须用 edges 而不是 plot.w/nx：几何约定「行 0 在底部」（y.edges 递减），
  // 且轴可能是非均匀采样，用等分公式会既上下镜像、又把非均匀格子画歪。
  const xEdges = geometry.x.edges
  const yEdges = geometry.y.edges
  const animated = motion.enabled

  // 按“颜色 + 不透明度”分组批量填充：静态状态（动画结束后）通常只有几十~几百组，
  // 每组一次 fill，避免 1 万次 fillStyle 切换。100×100 逐格 flush 实测中位约 10ms，
  // 分组后回落到 8ms 红线以内。入场动画期间每格 alpha 不同，退回逐格绘制。
  const groups = new Map<string, { path: Path2D; color: string }>()
  const highlights = new Map<string, Path2D>()

  const cellColor = (index: number, state: number, value: number): string => {
    if (mode !== 'binary') return sampleHeatColor(valueToT(value, site.valueRange))
    // 分支在数据层就定好（flatBinary 来自数据集级判定），渲染时只做一次判断：
    //  - false：明度随 |margin| 变化（贴近 spec 更暗，远离更亮）；
    //  - true：没有连续量可表达，整片平涂 iOS 系统色。
    return input.flatBinary
      ? passFailColor(state)
      : binaryMarginColor(state, tint ? tint[index] : 0.5)
  }

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const index = iy * nx + ix
      const value = site.value[index]
      const state = site.pass[index]
      const alpha = cellAlpha(ix, iy, nx, ny, motion)
      if (alpha <= 0.001) continue

      // 缝宽固定 1 逻辑像素：两侧各内缩 0.5，相邻格之间自然留出 1px 底色。
      // 这里不做设备像素取整——圆角本身需要抗锯齿，强行对齐反而会让缝宽忽大忽小。
      const left = xEdges[ix]
      const right = xEdges[ix + 1]
      const bottom = yEdges[iy]
      const top = yEdges[iy + 1]
      const x = left + halfGap
      const y = top + halfGap
      const w = right - left - CELL_GAP
      const h = bottom - top - CELL_GAP
      if (w <= 0.5 || h <= 0.5) continue

      const radius = cellCornerRadius(w, h)

      // 缺失点：深底 + 45° 斜纹（裁剪到圆角内，边缘仍然干净）；数量通常极少，逐格画
      if (state === CELL_UNKNOWN || !Number.isFinite(value)) {
        ctx.globalAlpha = alpha
        ctx.fillStyle = BINARY_PALETTE.unknownBase
        ctx.beginPath()
        ctx.roundRect(x, y, w, h, radius)
        ctx.fill()
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(x, y, w, h, radius)
        ctx.clip()
        drawCellHatch(ctx, x, y, w, h)
        ctx.restore()
        continue
      }

      const color = cellColor(index, state, value)

      if (!animated) {
        // 静态状态：同色格子合到一个 Path2D，最后统一填充
        let group = groups.get(color)
        if (!group) {
          group = { path: new Path2D(), color }
          groups.set(color, group)
        }
        group.path.roundRect(x, y, w, h, radius)

        // 极轻的顶部高光：格子太小时（100×100）直接跳过，避免糊成灰边
        if (Math.min(w, h) >= HIGHLIGHT_MIN_SHORT) {
          let hp = highlights.get('1')
          if (!hp) {
            hp = new Path2D()
            highlights.set('1', hp)
          }
          hp.rect(x + radius, y + 0.75 / dpr, Math.max(0, w - radius * 2), 1 / dpr)
        }
        continue
      }

      // 入场中：每格 alpha 不同，逐格填充
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, radius)
      ctx.fill()
    }
  }

  // 批量落盘：先色块，再统一叠高光（同一条路径一次填充）
  ctx.globalAlpha = 1
  for (const group of groups.values()) {
    ctx.fillStyle = group.color
    ctx.fill(group.path)
  }
  if (highlights.size > 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
    for (const path of highlights.values()) ctx.fill(path)
  }
  ctx.globalAlpha = 1
}


/**
 * 绘制静态层：背景（含 vignette）→ 圆角色块 → 噪点 → 边框 → 切片标记 → 坐标轴 → 图例
 */
export function drawStaticLayer(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const { geometry } = input
  const { plot } = geometry
  const { dpr, width, height } = size

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // 1. 画布底色：比面板更暗，让色块成为唯一视觉焦点；格缝露出的就是这层底色
  ctx.fillStyle = CHART_STRUCTURE.canvasBg
  ctx.fillRect(0, 0, width, height)

  if (plot.w <= 2 || plot.h <= 2) return

  // 2. 背景层 vignette：必须在色块之前，保证不压在数据上（≤1.2%）
  drawVignette(ctx, geometry)

  // 3. 圆角色块（二值 / 热力共用一套画法，缺测格带斜纹）
  drawCells(ctx, size, input)

  // 4. 整个数据区叠约 2% 噪点纹理（模拟仪器屏幕的颗粒感）
  drawNoiseOverlay(ctx, geometry)

  // 5. 数据区边框 + 当前站点高亮框（内缩 3px，青色细线，不抢色块）

  ctx.strokeStyle = CHART_STRUCTURE.axisLine
  ctx.strokeRect(snap(plot.x, dpr) + 0.5 / dpr, snap(plot.y, dpr) + 0.5 / dpr, plot.w, plot.h)
  ctx.strokeStyle = CHART_STRUCTURE.activeFrame
  ctx.strokeRect(
    snap(plot.x, dpr) + 3.5 / dpr,
    snap(plot.y, dpr) + 3.5 / dpr,
    plot.w - 7,
    plot.h - 7
  )

  // 7. 切片标记：虚线框标出刚才切出去的那一行/列（仅在返回 2D 后出现）
  drawSliceMarker(ctx, size, input)

  // 8. 坐标轴（刻度对齐真实采样值）
  drawAxes(ctx, size, input)
  // 9. 图例
  drawLegend(ctx, size, input)
}

/**
 * 切片标记：虚线框 + 6% 白色提亮。
 * 时间顺序上，它出现在色块与网格之后、坐标轴之前，保证轴刻度不会被盖住。
 */
function drawSliceMarker(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const marker = input.sliceMarker
  if (!marker) return

  const { geometry } = input
  const { plot } = geometry
  const { dpr } = size

  let left = plot.x
  let top = plot.y
  let width = plot.w
  let height = plot.h

  if (marker.axis === 'row') {
    if (marker.index < 0 || marker.index + 1 >= geometry.y.edges.length) return
    top = geometry.y.edges[marker.index + 1]
    height = geometry.y.edges[marker.index] - top
  } else {
    if (marker.index < 0 || marker.index + 1 >= geometry.x.edges.length) return
    left = geometry.x.edges[marker.index]
    width = geometry.x.edges[marker.index + 1] - left
  }
  if (width <= 0 || height <= 0) return

  const x = snap(left, dpr)
  const y = snap(top, dpr)
  const w = Math.max(1, snap(left + width, dpr) - x)
  const h = Math.max(1, snap(top + height, dpr) - y)

  ctx.fillStyle = 'rgba(230, 238, 247, 0.06)'
  ctx.fillRect(x, y, w, h)

  ctx.save()
  ctx.strokeStyle = CHART_STRUCTURE.hoverBorder
  ctx.lineWidth = 1
  ctx.setLineDash([5, 3])
  ctx.strokeRect(x + 0.5 / dpr, y + 0.5 / dpr, w - 1 / dpr, h - 1 / dpr)
  ctx.restore()
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
  const { geometry, site, mode, valueLabel, valueUnit } = input
  const { plot } = geometry
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
    // 纯二值数据没有 margin 可编码：色卡改为平涂系统色，说明文字换成“二值判定”
    const flat = input.flatBinary === true
    rows.forEach((row, i) => {
      const y = y0 + 24 + i * 18
      if (row.hatch) {
        ctx.fillStyle = BINARY_PALETTE.unknownBase
        ctx.fillRect(x0, y - 5, 10, 10)
        // 与色块一致的斜纹示意：复用同一个描线函数，步长按 10px 小色卡缩小
        drawCellHatch(ctx, x0, y - 5, 10, 10, 4)
      } else if (flat) {
        ctx.fillStyle = row.state === 1 ? PASSFAIL_PALETTE.pass : PASSFAIL_PALETTE.fail
        ctx.fillRect(x0, y - 5, 10, 10)
        ctx.strokeStyle = 'rgba(147, 166, 186, 0.22)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(x0 + 0.25, y - 4.75, 9.5, 9.5)
      } else {
        // 色卡画成“暗端 → 锚点”的竖向渐变，与主图的 margin 明度调制同源
        const stops = binarySwatchStops(row.state, 4)
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

    // 说明图例的编码方式：连续值解释明度，纯二值则注明判定口径
    ctx.fillStyle = CHART_STRUCTURE.legendMuted
    ctx.font = FONT_MONO_SMALL
    ctx.fillText(flat ? '二值判定' : '明度 ∝ |margin|', x0, y0 + 24 + rows.length * 18 + 2)
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
  const steps = heatGradientStops(24)
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
 * 边界层：阶梯边界 + （可选）氛围动效。
 *
 * 只画“相邻格状态不同”的 1px 极淡白线（横向/纵向各自独立），不平滑、不移位，
 * 保证每一格的状态都能在放大时对得上；圆角造成的格缝不会影响这条边界的位置。
 *
 * 氛围动效（默认关闭）：边界线 4s 极轻呼吸 + 图区噪点缓慢平移。
 * 只在这一层重绘，不触碰静态层的色块，因此开启时仍然只有很小的绘制面积。
 */
export function drawBoundaryLayer(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput,
  ambient?: AmbientInput | null
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
  // 边界随色块一起淡入，等最后一层色块开始后再出现，避免“框先于色块”
  const alpha = motion.enabled
    ? Math.min(1, Math.max(0, (motion.elapsed - (ENTRANCE_TOTAL - 240)) / 320))
    : 1
  if (alpha <= 0) return

  ctx.lineWidth = 1
  ctx.globalAlpha = alpha

  // ---- 相邻状态不同的格子边界（阶梯线，1px 低对比） ----
  const stateAt = (ix: number, iy: number): number => site.pass[iy * nx + ix]
  const known = (s: number) => s !== CELL_UNKNOWN

  ctx.strokeStyle = CHART_STRUCTURE.boundary
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

  // —— 氛围动效：只在显式开启时绘制，且只在 boundary 层 ——
  // 效果一：边界线 4s 周期极轻呼吸（0.55→1 的透明度起伏）；
  // 效果二：整个数据区叠一层缓慢平移的噪点（≤6%），像仪器屏幕的微光。
  // 两者都很便宜：一次 stroke + 一次 pattern 填充，不重建几何。
  if (ambient) {
    const breathe = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(ambient.phase))
    ctx.strokeStyle = CHART_STRUCTURE.boundary
    ctx.globalAlpha = alpha * breathe
    ctx.stroke()

    const pattern = getNoisePattern(ctx)
    if (pattern && typeof DOMMatrix !== 'undefined') {
      const matrix = new DOMMatrix().translate(ambient.drift, ambient.drift * 0.6)
      pattern.setTransform(matrix)
      ctx.save()
      ctx.globalAlpha = 0.06
      ctx.fillStyle = pattern
      ctx.fillRect(plot.x, plot.y, plot.w, plot.h)
      ctx.restore()
    }
  }

  ctx.globalAlpha = 1
}

/** 涟漪持续时间（ms）：快速衰减，不留残影 */
const RIPPLE_DURATION = 300

/** 交互层：十字准线（贯穿全图） + hover 格描边 + 涟漪；每帧全清 */
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

  // 整行提示：8% 白色叠加，覆盖绘图区整行（含格子之间的缝隙），
  // 目的是让“这一行可以被双击切开”这件事在不喧宾夺主的前提下可被察觉。
  const hoverRow = input.hoverRow
  if (typeof hoverRow === 'number' && hoverRow >= 0 && hoverRow < geometry.y.edges.length - 1) {
    const top = geometry.y.edges[hoverRow + 1]
    const bottom = geometry.y.edges[hoverRow]
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.fillRect(plot.x, snap(top, dpr), plot.w, snap(bottom, dpr) - snap(top, dpr))
  }

  const center = cellCenter(geometry, hover.ix, hover.iy)
  const cx = snap(center.x, dpr)
  const cy = snap(center.y, dpr)

  // 涟漪：从命中点扩散的细环 + 极淡径向填充，300ms 内衰减到 0
  const ripple = input.ripple
  if (ripple && ripple.elapsed >= 0 && ripple.elapsed < RIPPLE_DURATION) {
    const t = ripple.elapsed / RIPPLE_DURATION
    const radius = 6 + t * Math.min(140, Math.max(plot.w, plot.h) * 0.22)
    const fade = (1 - t) * (1 - t)

    const gradient = ctx.createRadialGradient(ripple.x, ripple.y, 0, ripple.x, ripple.y, radius)
    gradient.addColorStop(0, `rgba(111, 227, 239, ${(0.16 * fade).toFixed(4)})`)
    gradient.addColorStop(0.7, `rgba(111, 227, 239, ${(0.05 * fade).toFixed(4)})`)
    gradient.addColorStop(1, 'rgba(111, 227, 239, 0)')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = `rgba(111, 227, 239, ${(0.45 * fade).toFixed(4)})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2)
    ctx.stroke()
  }

  // 十字准线：贯穿全图（图框外更淡），吸附到格子中心，虚线
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.strokeStyle = CHART_STRUCTURE.crosshairSoft
  ctx.beginPath()
  ctx.moveTo(cx + 0.5 / dpr, 0)
  ctx.lineTo(cx + 0.5 / dpr, plot.y)
  ctx.moveTo(cx + 0.5 / dpr, plot.y + plot.h)
  ctx.lineTo(cx + 0.5 / dpr, height)
  ctx.moveTo(0, cy + 0.5 / dpr)
  ctx.lineTo(plot.x, cy + 0.5 / dpr)
  ctx.moveTo(plot.x + plot.w, cy + 0.5 / dpr)
  ctx.lineTo(width, cy + 0.5 / dpr)
  ctx.stroke()

  ctx.strokeStyle = CHART_STRUCTURE.crosshair
  ctx.beginPath()
  ctx.moveTo(cx + 0.5 / dpr, plot.y)
  ctx.lineTo(cx + 0.5 / dpr, plot.y + plot.h)
  ctx.moveTo(plot.x, cy + 0.5 / dpr)
  ctx.lineTo(plot.x + plot.w, cy + 0.5 / dpr)
  ctx.stroke()
  ctx.setLineDash([])

  // 当前格描边：亮青色，1.5px；跟随圆角单元格的形状（半径与填充一致），
  // 外扩约 0.75px，保证描边压在格缝上而不是吃进色块。
  const rect = cellRect(geometry, hover.ix, hover.iy)
  const inset = 0.75
  const hw = Math.max(0, rect.w - CELL_GAP + inset * 2)
  const hh = Math.max(0, rect.h - CELL_GAP + inset * 2)
  ctx.strokeStyle = CHART_STRUCTURE.hoverBorder
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(
    rect.x + CELL_GAP / 2 - inset,
    rect.y + CELL_GAP / 2 - inset,
    hw,
    hh,
    cellCornerRadius(rect.w - CELL_GAP, rect.h - CELL_GAP) + inset
  )
  ctx.stroke()
}
