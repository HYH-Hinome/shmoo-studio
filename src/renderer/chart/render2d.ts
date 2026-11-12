import type { Axis, SiteGrid } from '@shared/types/shmoo'
import { CELL_UNKNOWN } from '@shared/types/shmoo'
import {
  BINARY_PALETTE,
  CHART_STRUCTURE,
  binaryMarginColor,
  binarySwatchStops,
  heatGradientStops,
  inkTone,
  sampleHeatColor,
  valueToT
} from './colors'
import type { InkScene, Pt } from './contour'
import { buildInkScene } from './contour'
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
 * 分层职责（视觉重做后）：
 *  - staticLayer：背景（含 vignette）→ 有机墨迹色块 / 逐格色块 → 未知格斜纹
 *    → 点阵坐标参考 → 噪点纹理 → 数据区边框 → 切片标记 → 坐标轴 → 图例；
 *  - boundaryLayer：FAIL 区精确边界（墨迹模式）+ 可选的氛围辉光/噪声流动；
 *  - interactionLayer：十字准线 + hover 格描边 + 涟漪，每帧只清这一层。
 *
 * 性能约束：
 *  - 轮廓提取与噪声位移按数据集缓存（contour.ts 内部 WeakMap），不逐帧重算；
 *  - 逐格填充全部用 fillRect；点阵用一个 Path2D 一次性填充；
 *  - 静态层只在数据/尺寸/模式变化时重绘，默认状态完全静止。
 */

export type ChartColorMode = 'binary' | 'heat'

/**
 * 二值模式的两种着色方式：
 *  - ink：默认。取消逐格实心填充，用有机墨迹轮廓上色，背景给点阵坐标参考；
 *  - cell：逐格。每格独立填充，用于精确定位单点、确认稀疏数据里某一格的状态。
 */
export type ChartRenderMode = 'ink' | 'cell'

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
  /** 二值模式的着色方式；默认 ink（有机墨迹） */
  renderMode?: ChartRenderMode
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

/** 墨迹入场：按到图心距离分成 6 层，每层间隔 30ms，同层一起点亮 */
export const INK_LAYER_COUNT = 6
export const INK_LAYER_DELAY = 30
const INK_LAYER_DURATION = 240

/**
 * 墨迹层的入场不透明度。
 * 与逐格模式的对角线顺序不同：整块区域按层批量出现，避免大图逐格串行导致总时长失控。
 */
export function inkLayerAlpha(layer: number, motion: MotionInput): number {
  if (!motion.enabled) return 1
  const startedAt = layer * INK_LAYER_DELAY
  if (motion.elapsed <= startedAt) return 0
  return easeOutCubic((motion.elapsed - startedAt) / INK_LAYER_DURATION)
}

/** 用折线构造闭合路径；points 可能带重复的收尾点，这里统一 closePath */
function tracePath(target: CanvasRenderingContext2D | Path2D, points: Pt[]): void {
  if (points.length < 3) return
  target.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) target.lineTo(points[i].x, points[i].y)
  target.closePath()
}

/** 取轮廓场景（contour.ts 内部按数据集缓存，重复调用不会重算） */
function sceneFor(input: ChartDataInput): InkScene {
  return buildInkScene(input.geometry.x.edges, input.geometry.y.edges, input.site.pass)
}

/** 点阵坐标参考：每个格子中心 1 个设备像素点，rgba(255,255,255,0.05) */
function drawDotLattice(ctx: CanvasRenderingContext2D, size: CanvasSize, geometry: ChartGeometry): void {
  const { dpr } = size
  const { plot } = geometry
  const nx = geometry.x.values.length
  const ny = geometry.y.values.length
  const dot = 1 / dpr

  const path = new Path2D()
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const center = cellCenter(geometry, ix, iy)
      // 对齐设备像素，保证 1 像素点清晰、不发灰
      const x = Math.round(center.x * dpr) / dpr
      const y = Math.round(center.y * dpr) / dpr
      path.rect(x - dot / 2, y - dot / 2, dot, dot)
    }
  }
  ctx.fillStyle = CHART_STRUCTURE.dotLattice
  ctx.fill(path)
  // plot 仅用于语义提示：点阵严格覆盖数据区，不越过边框
  void plot
}

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
 * 墨迹模式：把 PASS / FAIL 连通区画成有层次的色块。
 *
 * 画法顺序（保证“硬边 + 柔和墨迹压在外面”）：
 *  1. 用墨迹轮廓填充高光→阴影的竖向渐变（有仪器金属感的基础层）；
 *  2. 用同一路径裁剪，逐格叠加 A′ 的 margin 明度色 —— 保留原来的判读编码；
 *  3. 精确的 1px 边界由 boundary 层负责，不在这里画。
 */
function drawInkRegions(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  scene: InkScene,
  dpr: number
): void {
  const { geometry, site, motion, tint } = input
  const { plot } = geometry
  const nx = geometry.x.values.length
  const centerX = plot.x + plot.w / 2
  const centerY = plot.y + plot.h / 2
  const maxDist = Math.max(1, Math.hypot(plot.w, plot.h) / 2)

  for (const region of scene.regions) {
    const distance = Math.hypot(region.anchor.x - centerX, region.anchor.y - centerY)
    const layer = Math.min(INK_LAYER_COUNT - 1, Math.floor((distance / maxDist) * INK_LAYER_COUNT))
    const alpha = inkLayerAlpha(layer, motion)
    if (alpha <= 0.002) continue

    const tone = inkTone(region.state)
    // 每个连通区一条路径：多个环（外轮廓 + 孔洞）一次填充，避免环之间出现接缝
    const shape = new Path2D()
    region.exactLoops.forEach((exact, index) => {
      const ink = region.inkLoops[index]
      const points = ink ?? exact
      // 路径上每个环各自 moveTo，避免不同环被连成一条线
      tracePath(shape, points)
    })

    ctx.save()
    ctx.globalAlpha = alpha

    const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h)
    gradient.addColorStop(0, tone.highlight)
    gradient.addColorStop(0.42, tone.base)
    gradient.addColorStop(1, tone.shadow)
    ctx.fillStyle = gradient
    ctx.fill(shape)
    ctx.strokeStyle = tone.edge
    ctx.lineWidth = 1
    ctx.stroke(shape)

    // 在墨迹形状内叠加逐格 margin 明度，保证“亮 = 更结实”的编码不丢失
    ctx.clip(shape)
    for (const index of region.cells) {
      const ix = index % nx
      const iy = (index - ix) / nx
      const state = site.pass[index]
      if (state === CELL_UNKNOWN) continue
      const m = tint ? tint[index] : 0.5
      const rect = cellRect(geometry, ix, iy)
      ctx.fillStyle = binaryMarginColor(state, m)
      // 0.58 让底层的渐变在高光/阴影方向透出更多，逐格的 margin 明度只作为“轻微起伏”，
      // 不再形成一眼可见的方格拼布（0.82 时整片区域会像贴了瓷砖，和“有机墨迹”冲突）。
      ctx.globalAlpha = alpha * 0.58
      // 对齐到设备像素：相邻格共享同一条像素边界，避免 +0.5 重叠导致的重叠处二次叠加，
      // 那样会在整片色块里透出规则的方格缝（放大看就是“拼布”）。
      const left = snap(rect.x, dpr)
      const top = snap(rect.y, dpr)
      const right = snap(rect.x + rect.w, dpr)
      const bottom = snap(rect.y + rect.h, dpr)
      ctx.fillRect(left, top, right - left, bottom - top)
    }

    ctx.restore()
  }
}

/** 未知格：深底 + 45° 斜纹；墨迹模式下必须盖在墨迹之上，表达“没有数据” */
function drawUnknownCells(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const { geometry, site, motion } = input
  const { dpr } = size
  const nx = geometry.x.values.length
  const ny = geometry.y.values.length

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const index = iy * nx + ix
      if (site.pass[index] !== CELL_UNKNOWN) continue
      const alpha = cellAlpha(ix, iy, nx, ny, motion)
      if (alpha <= 0.002) continue

      const rect = cellRect(geometry, ix, iy)
      const left = snap(rect.x, dpr)
      const top = snap(rect.y, dpr)
      const right = snap(rect.x + rect.w, dpr)
      const bottom = snap(rect.y + rect.h, dpr)
      ctx.globalAlpha = alpha
      ctx.fillStyle = BINARY_PALETTE.unknownBase
      ctx.fillRect(left, top, right - left, bottom - top)
      drawCellHatch(ctx, left, top, right - left, bottom - top)
    }
  }
  ctx.globalAlpha = 1
}

/** 逐格模式：每格独立填充（原 A′ 视觉，保留给精确判读） */
function drawCells(ctx: CanvasRenderingContext2D, size: CanvasSize, input: StaticLayerInput): void {
  const { geometry, site, mode, motion, tint } = input
  const { dpr } = size
  const nx = geometry.x.values.length
  const ny = geometry.y.values.length

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
        ctx.fillStyle = BINARY_PALETTE.unknownBase
        ctx.fillRect(left, top, w, h)
        drawCellHatch(ctx, left, top, w, h)
      } else if (mode === 'binary') {
        // 定稿 A′：明度随 |margin| 变化（贴近 spec 更暗，远离更亮）
        const m = tint ? tint[index] : 0.5
        ctx.fillStyle = binaryMarginColor(state, m)
        ctx.fillRect(left, top, right - left, bottom - top)
      } else {
        const t = valueToT(value, site.valueRange)
        ctx.fillStyle = sampleHeatColor(t)
        ctx.fillRect(left, top, right - left, bottom - top)
      }
    }
  }
  ctx.globalAlpha = 1
}


/**
 * 绘制静态层：背景（含 vignette）→ 墨迹/逐格色块 → 缺测格斜纹
 *                → 点阵/网格 → 噪点 → 边框 → 切片标记 → 坐标轴 → 图例
 */
export function drawStaticLayer(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput
): void {
  const { geometry, mode, renderMode = 'ink' } = input
  const { plot } = geometry
  const { dpr, width, height } = size

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // 1. 画布底色：比面板更暗，让色块成为唯一视觉焦点
  ctx.fillStyle = CHART_STRUCTURE.canvasBg
  ctx.fillRect(0, 0, width, height)

  if (plot.w <= 2 || plot.h <= 2) return

  const nx = geometry.x.values.length
  const ny = geometry.y.values.length
  // 墨迹只用于二值模式：热力是连续场，没有“FAIL 连通区”这个概念
  const useInk = mode === 'binary' && renderMode === 'ink'

  // 2. 背景层 vignette：必须在色块之前，保证不压在数据上（≤1.2%）
  drawVignette(ctx, geometry)

  // 3. 色块
  if (useInk) {
    drawInkRegions(ctx, input, sceneFor(input), dpr)
    // 未知格永远盖在墨迹上（墨迹不会侵入缺测格，但边界处仍需要斜纹表达“未测”）
    drawUnknownCells(ctx, size, input)
  } else {
    drawCells(ctx, size, input)
  }

  // 4. 坐标参考：墨迹模式用 1px 点阵；逐格模式保留原来的矩阵网格线
  if (useInk) {
    drawDotLattice(ctx, size, geometry)
  } else {
    ctx.strokeStyle = CHART_STRUCTURE.gridLine
    ctx.lineWidth = 1
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
  }

  // 5. 整个数据区叠约 2% 噪点纹理（含墨迹与空白，模拟仪器屏幕的颗粒感）
  drawNoiseOverlay(ctx, geometry)

  // 6. 数据区边框 + 当前站点高亮框（内缩 3px，青色细线，不抢色块）
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
    rows.forEach((row, i) => {
      const y = y0 + 24 + i * 18
      if (row.hatch) {
        ctx.fillStyle = BINARY_PALETTE.unknownBase
        ctx.fillRect(x0, y - 5, 10, 10)
        // 与色块一致的斜纹示意：复用同一个描线函数，步长按 10px 小色卡缩小
        drawCellHatch(ctx, x0, y - 5, 10, 10, 4)
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

    // 说明图例的编码方式，避免把“亮 = 更结实”误读成“亮 = 更好/更差”
    ctx.fillStyle = CHART_STRUCTURE.legendMuted
    ctx.font = FONT_MONO_SMALL
    ctx.fillText('明度 ∝ |margin|', x0, y0 + 24 + rows.length * 18 + 2)
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
 * 边界层：精确边界 + （可选）氛围动效。
 *
 * 墨迹模式：直接用 contour.ts 的**精确轮廓**（marching squares 输出，落在真实格子边界上）
 * 描 1px 极淡白线。它和静态层的墨迹形状是同一份数据源，但位置一格不差；
 * 视觉上形成“一条硬边 + 一层柔和墨迹压在外面”，而不是两条互相打架的线。
 *
 * 逐格模式：保留原来的“相邻状态不同即画边”的阶梯边界。
 *
 * 氛围动效（默认关闭）：FAIL 区辉光呼吸 + 轮廓噪声缓慢流动。
 * 只在这一层重绘，不触碰静态层的色块，因此开启时仍然只有很小的绘制面积。
 */
export function drawBoundaryLayer(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  input: StaticLayerInput,
  ambient?: AmbientInput | null
): void {
  const { geometry, site, mode, motion, renderMode = 'ink' } = input
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

  ctx.lineWidth = 1
  ctx.globalAlpha = alpha

  if (renderMode === 'ink') {
    const scene = sceneFor(input)
    const failShape = new Path2D()
    let hasFail = false
    for (const region of scene.regions) {
      if (region.state !== 'fail') continue
      for (const loop of region.exactLoops) {
        tracePath(failShape, loop)
        hasFail = true
      }
    }

    // 1px 精确边界：位置即数据边界，不做任何位移/平滑
    ctx.strokeStyle = CHART_STRUCTURE.exactBoundary
    ctx.stroke(failShape)

    // —— 氛围动效：只在显式开启时绘制 ——
    if (ambient && hasFail) {
      const breathe = 0.5 + 0.5 * Math.sin(ambient.phase)
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = `rgba(192, 69, 62, ${(0.035 + breathe * 0.05).toFixed(4)})`
      ctx.fill(failShape)
      ctx.restore()

      // 轮廓噪声流动：裁剪到 FAIL 形状内，平移噪点 pattern，不重建路径
      const pattern = getNoisePattern(ctx)
      if (pattern && typeof DOMMatrix !== 'undefined') {
        const matrix = new DOMMatrix().translate(ambient.drift, ambient.drift * 0.6)
        pattern.setTransform(matrix)
        ctx.save()
        ctx.clip(failShape)
        ctx.globalAlpha = 0.06
        ctx.fillStyle = pattern
        ctx.fillRect(plot.x, plot.y, plot.w, plot.h)
        ctx.restore()
      }
    }
    ctx.globalAlpha = 1
    return
  }

  // ---- 逐格模式：相邻状态不同的格子边界 ----
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
