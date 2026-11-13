/**
 * PNG 导出（阶段 ⑦）。
 *
 * 复用屏幕上的静态层绘制函数（drawStaticLayer / drawOneDStatic），保证：
 *  - 色块、坐标轴、刻度、轴标题、图例与屏幕完全同源；
 *  - 圆角、格缝、噪点、vignette 这些“质感层”原样保留；
 *  - 只画静态层，交互层（悬停浮层、锁定描边、框选矩形）根本不会进入导出画布。
 *
 * 与屏幕的唯一差异是顶部多留一条标题区（PNG 里没有 DOM 头部），
 * 通过把 geometry 的 top padding 加大来腾出空间，不改变任何图内排版规则。
 */

import type { ShmooDataset, SiteGrid } from '../../shared/types/shmoo'
import { CHART_STRUCTURE, computeMarginTints } from '../chart/colors'
import { DEFAULT_PADDING, computeGeometry, type ChartPadding } from '../chart/geometry'
import type { CanvasSize, ChartColorMode } from '../chart/render2d'
import { drawStaticLayer } from '../chart/render2d'
import type { OneDForm } from '../chart/render1d'
import { drawOneDStatic } from '../chart/render1d'

/** 标题区高度（CSS px）：标题 + 副标题 + 分隔线 */
export const PNG_HEADER_HEIGHT = 76

/** 导出缩放倍数：2× / 3×，保证 4K 屏上清晰 */
export type PngScale = 2 | 3

/** 画布工厂类型：默认用 document，Node 端测试可注入 @napi-rs/canvas */
export type CanvasFactory = () => HTMLCanvasElement

export interface PngExportInput {
  dataset: ShmooDataset
  site: SiteGrid
  /** 2D 配色模式；1D 数据集忽略 */
  mode: ChartColorMode
  /** 1D 形态；2D 数据集忽略 */
  form: OneDForm
  /** 纯二值数据集（0/1 pattern / passfail）：使用饱和平涂色 */
  flatBinary: boolean
  /** 可选的 |margin| 归一化数组；不传时按 0.5 兜底 */
  tint?: Float32Array | null
  /** 图表区 CSS 宽度（不含标题区） */
  width: number
  /** 图表区 CSS 高度（不含标题区） */
  height: number
  /** 2× / 3× */
  scale: PngScale
}

/** 副标题：站点 + spec，由调用方用 shared/export/format 拼好 */
export interface PngHeaderInfo {
  subtitle: string
}

/** 4 位小数的画布尺寸校验，避免 0 宽高导致 toDataURL 失败 */
function safeCssSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * 绘制导出用的离屏画布。
 * 返回的 canvas 已按 scale 放大（canvas.width = CSS 宽 × scale），
 * 背景为画布底色实色填充，不保留透明通道。
 */
export function renderExportCanvas(
  input: PngExportInput,
  header: PngHeaderInfo,
  createCanvas: CanvasFactory = () => document.createElement('canvas')
): HTMLCanvasElement {
  const cssWidth = safeCssSize(input.width)
  const cssHeight = safeCssSize(input.height)
  if (cssWidth < 40 || cssHeight < 40) {
    throw new Error('图表区域太小，无法导出')
  }

  const dpr = input.scale
  const totalHeight = cssHeight + PNG_HEADER_HEIGHT
  const canvas = createCanvas()
  canvas.width = Math.max(1, Math.round(cssWidth * dpr))
  canvas.height = Math.max(1, Math.round(totalHeight * dpr))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建导出画布')

  const size: CanvasSize = { width: cssWidth, height: totalHeight, dpr }
  // 顶部多留标题区：其余留白保持与屏幕一致
  const padding: ChartPadding = { ...DEFAULT_PADDING, top: DEFAULT_PADDING.top + PNG_HEADER_HEIGHT }

  // 先铺满底色：位图不能是透明底（贴进文档里会变黑）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = CHART_STRUCTURE.canvasBg
  ctx.fillRect(0, 0, cssWidth, totalHeight)

  const tint = input.tint ?? computeMarginTints(input.site, input.dataset.spec)

  if (input.dataset.kind === '1d') {
    drawOneDStatic(
      ctx,
      size,
      {
        dataset: input.dataset,
        site: input.site,
        form: input.form,
        tint,
        flatBinary: input.flatBinary,
        // 导出是静帧：关闭入场动效，保证任何时刻导出结果一致
        motion: { enabled: false, elapsed: 0, duration: 0 },
        padding
      }
    )
  } else {
    if (!input.dataset.yAxis) throw new Error('2D 数据集缺少 y 轴')
    const geometry = computeGeometry(
      cssWidth,
      totalHeight,
      padding,
      input.dataset.xAxis.values,
      input.dataset.yAxis.values
    )
    drawStaticLayer(ctx, size, {
      geometry,
      xAxis: input.dataset.xAxis,
      yAxis: input.dataset.yAxis,
      site: input.site,
      valueLabel: input.dataset.valueLabel,
      valueUnit: input.dataset.valueUnit,
      mode: input.mode,
      flatBinary: input.flatBinary,
      tint,
      motion: { enabled: false, elapsed: 0 },
      // 切片标记属于“上一次交互的残留”，导出时一律不画
      sliceMarker: null
    })
  }

  drawExportHeader(ctx, dpr, cssWidth, input.dataset.title, header.subtitle)
  return canvas
}

/**
 * 画标题区：数据集标题 + 站点/spec 副标题 + 一条细分隔线。
 * 字体优先使用界面同款等宽字体；中文回退到系统黑体（位图导出无需嵌入字体）。
 */
function drawExportHeader(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  width: number,
  title: string,
  subtitle: string
): void {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const maxWidth = Math.max(40, width - 40)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = CHART_STRUCTURE.axisTitle
  ctx.font = '600 15px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif'
  ctx.fillText(fitCanvasText(ctx, title, maxWidth), 20, 27)

  ctx.fillStyle = CHART_STRUCTURE.legendText
  ctx.font = '10px "JetBrains Mono", "Cascadia Mono", Consolas, monospace'
  ctx.fillText(fitCanvasText(ctx, subtitle, maxWidth), 20, 47)

  ctx.strokeStyle = CHART_STRUCTURE.axisLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(20, 60.5)
  ctx.lineTo(width - 20, 60.5)
  ctx.stroke()

  ctx.restore()
}

/** 按当前 ctx.font 截断文字并加省略号，保证标题/副标题不越出画布 */
function fitCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let cut = text
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return cut.length > 0 ? `${cut}…` : ''
}

/**
 * 计算导出位图的像素尺寸（给对话框展示与测试断言用）。
 * 高度包含标题区；宽度只包含图表区。
 */
export function computePngPixelSize(
  width: number,
  height: number,
  scale: PngScale
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(safeCssSize(width) * scale)),
    height: Math.max(1, Math.round((safeCssSize(height) + PNG_HEADER_HEIGHT) * scale))
  }
}
