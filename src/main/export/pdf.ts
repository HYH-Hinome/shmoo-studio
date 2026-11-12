/**
 * 矢量 PDF 导出（阶段 ⑦）。
 *
 * 为什么在主进程用 pdfkit 生成，而不是把 Canvas 截图塞进 PDF：
 *  - 要求“色块 / 坐标轴 / 刻度线 / 文字全部矢量，文字可选中可搜索”；
 *  - pdfkit 会把嵌入的 TTF 子集化（只嵌入用到的字形），中文字体随文件分发，
 *    在别人的机器上不会变成方框；
 *  - 字体度量直接来自嵌入字体（fontkit），刻度抽稀按 PDF 自己的文字宽度计算，
 *    因此不会出现“按 Canvas 宽度排好、到 PDF 里却重叠”的问题。
 *
 * 本文件只做绘制，不读写磁盘、不依赖 Electron，便于在 Vitest 里直接跑几何断言。
 * 坐标全部为 pt，原点在页面左上角，y 向下（与 pdfkit 一致）。
 */

import PDFDocument from 'pdfkit'
import type {
  ExportChartPage,
  ExportDatasetInfo,
  ExportPdfRequest,
  ExportSiteSnapshot
} from '../../shared/types/export'
import type { SiteGrid } from '../../shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '../../shared/types/shmoo'
import { evaluatePoint } from '../../shared/spec/evaluate'
import {
  describePassSource,
  describeSpec,
  formatPassRate,
  formatReadableTime,
  pickLotMeta
} from '../../shared/export/format'
import {
  computeValueScale,
  findPassRuns,
  findRunBoundaries,
  pickPrimaryRun,
  RUN_BOUNDARY_LABEL,
  valueToY
} from '../../renderer/chart/oneD'
import {
  cellRect,
  computeGeometry,
  type ChartGeometry,
  pickTickIndices,
  tickDecimals
} from '../../renderer/chart/geometry'
import {
  BINARY_PALETTE,
  binaryMarginColor,
  binarySwatchStops,
  CHART_STRUCTURE,
  computeMarginTints,
  heatGradientStops,
  PASSFAIL_PALETTE,
  passFailColor,
  sampleHeatColor,
  valueToT
} from '../../renderer/chart/colors'
import {
  A4_LANDSCAPE,
  boxesOverlap,
  computePageLayout,
  PAGE_MARGIN,
  PDF_AXIS_TITLE_FONT,
  PDF_FOOTER_FONT,
  PDF_HEADER_SUB_FONT,
  PDF_HEADER_TITLE_FONT,
  PDF_LEGEND_FONT,
  PDF_TICK_FONT,
  type PdfPageLayout,
  type PdfTextBox
} from './layout'

/** 嵌入字体在 PDF 内部的名字（随便取，不参与显示） */
const FONT = 'shmoo-cjk'

/** 色块之间的格缝：1 CSS px @96dpi ≈ 0.75pt（与屏幕 1px 视觉宽度等比换算） */
const CELL_GAP = 0.75

/** PDF 里单格圆角：与屏幕 cellCornerRadius 同口径（短边 18%，夹到 1–3.4pt） */
function cellRadius(w: number, h: number): number {
  const short = Math.min(w, h)
  return Math.max(0, Math.min(3.4, Math.max(1, short * 0.18), short / 2 - 0.05))
}

/** 构建结果：字节 + 文字框审计（测试用它做重叠/越界断言） */
export interface PdfBuildResult {
  bytes: Uint8Array
  audit: {
    pageCount: number
    boxes: PdfTextBox[]
  }
}

/* ------------------------------------------------------------------ *
 * 文字绘制与度量
 * ------------------------------------------------------------------ */

interface TextOptions {
  size: number
  color: string
  align?: 'left' | 'center' | 'right'
  /** 文字框审计分类 */
  kind: PdfTextBox['kind']
  /** 最大可用宽度；超出时截断并加省略号，保证不溢出页面 */
  maxWidth?: number
}

/** 当前字体下测量文字宽度（pt） */
function measure(doc: PDFKit.PDFDocument, text: string, size: number): number {
  doc.font(FONT).fontSize(size)
  return doc.widthOfString(text)
}

/** 按最大宽度截断文字（加省略号）；maxWidth 缺省或足够宽时原样返回 */
function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  size: number,
  maxWidth?: number
): string {
  if (!maxWidth || measure(doc, text, size) <= maxWidth) return text
  let cut = text
  while (cut.length > 1 && measure(doc, `${cut}…`, size) > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return cut.length > 0 ? `${cut}…` : ''
}

/**
 * 画一行文字并记录审计框。
 * 注意：pdfkit 的 y 是“行顶”，不是基线；审计框高度取字号即可覆盖可见字形。
 */
function drawText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  options: TextOptions,
  page: number,
  boxes: PdfTextBox[]
): void {
  const content = text.length > 0 ? text : ''
  const width = measure(doc, content, options.size)
  const left =
    options.align === 'center' ? x - width / 2 : options.align === 'right' ? x - width : x
  doc.font(FONT).fontSize(options.size).fillColor(options.color)
  doc.text(content, left, y, { lineBreak: false })
  boxes.push({
    page,
    kind: options.kind,
    text: content,
    x: left,
    y,
    w: width,
    h: options.size
  })
}

/** 画旋转 -90° 的文字（y 轴标题），水平/垂直居中于 (cx, cy) */
function drawRotatedText(
  doc: PDFKit.PDFDocument,
  text: string,
  cx: number,
  cy: number,
  size: number,
  color: string,
  page: number,
  boxes: PdfTextBox[]
): void {
  const width = measure(doc, text, size)
  doc.save()
  doc.translate(cx, cy)
  doc.rotate(-90)
  doc.font(FONT).fontSize(size).fillColor(color)
  doc.text(text, -width / 2, -size / 2, { lineBreak: false })
  doc.restore()
  // 旋转后的页面坐标包围盒：宽=字高，高=文字宽
  boxes.push({
    page,
    kind: 'axis-title',
    text,
    x: cx - size / 2,
    y: cy - width / 2,
    w: size,
    h: width
  })
}

/** 画一条虚线 */
function dashedLine(
  doc: PDFKit.PDFDocument,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 0.6,
  dash: [number, number] = [3, 2]
): void {
  doc.save()
  doc.strokeColor(color).lineWidth(width)
  doc.dash(dash[0], { space: dash[1] })
  doc.moveTo(x1, y1).lineTo(x2, y2).stroke()
  doc.undash()
  doc.restore()
}

/** 画 45° 斜纹（缺失格），调用方负责裁剪区域 */
function hatchRect(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  step = 5
): void {
  if (w <= 1 || h <= 1) return
  doc.save()
  doc.lineWidth(0.45).strokeColor(CHART_STRUCTURE.hatchStroke)
  for (let c = step; c < w + h; c += step) {
    const tStart = Math.max(0, c - h)
    const tEnd = Math.min(w, c)
    if (tEnd - tStart < 0.5) continue
    doc
      .moveTo(x + tStart, y + c - tStart)
      .lineTo(x + tEnd, y + c - tEnd)
      .stroke()
  }
  doc.restore()
}

/* ------------------------------------------------------------------ *
 * 配色（与屏幕同源，便于测试直接断言）
 * ------------------------------------------------------------------ */

/**
 * 单格填充色。
 *  - flatBinary：0/1 pattern 这类没有连续量的数据，用饱和平涂色（#2DAF72 / #E04037）；
 *  - heat：按站点值域映射热力色带；
 *  - 其余：按 |margin| 做明度调制。
 */
export function pdfCellColor(
  state: number,
  options: {
    flatBinary: boolean
    mode: 'binary' | 'heat'
    tint: number
    value: number
    range: { min: number; max: number } | null
  }
): string {
  if (state === CELL_UNKNOWN) return BINARY_PALETTE.unknownBase
  if (options.flatBinary) return passFailColor(state)
  if (options.mode === 'heat') {
    return sampleHeatColor(valueToT(options.value, options.range))
  }
  return binaryMarginColor(state, options.tint)
}

/* ------------------------------------------------------------------ *
 * 2D 页面
 * ------------------------------------------------------------------ */

/** 绘制数据区内的全部色块（含缺失格斜纹） */
function drawCells2D(
  doc: PDFKit.PDFDocument,
  geometry: ChartGeometry,
  frameOrigin: { x: number; y: number },
  site: ExportSiteSnapshot,
  dataset: ExportDatasetInfo,
  page: ExportChartPage
): void {
  const nx = dataset.xAxis.values.length
  const ny = dataset.yAxis?.values.length ?? 0
  // 纯二值数据（0/1 pattern）没有连续 margin，必须走饱和平涂色
  const flatBinary = isFlatExportBinary(dataset, page)
  const mode = page.mode === 'heat' && !flatBinary ? 'heat' : 'binary'
  const tint = computeMarginTints(site as SiteGrid, dataset.spec)

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const index = iy * nx + ix
      if (index >= site.value.length) continue
      const rect = cellRect(geometry, ix, iy)
      // 格缝均分在四周：与 Canvas 版“每格内缩 0.5px”一致
      const x = frameOrigin.x + rect.x + CELL_GAP / 2
      const y = frameOrigin.y + rect.y + CELL_GAP / 2
      const w = rect.w - CELL_GAP
      const h = rect.h - CELL_GAP
      if (w <= 0.08 || h <= 0.08) continue

      const state = site.pass[index]
      const value = site.value[index]
      if (state === CELL_UNKNOWN || !Number.isFinite(value)) {
        doc.roundedRect(x, y, w, h, cellRadius(w, h)).fill(BINARY_PALETTE.unknownBase)
        doc.save()
        doc.roundedRect(x, y, w, h, cellRadius(w, h)).clip()
        hatchRect(doc, x, y, w, h)
        doc.restore()
        continue
      }

      const color = pdfCellColor(state, {
        flatBinary,
        mode,
        tint: tint ? tint[index] : 0.5,
        value,
        range: site.valueRange
      })
      doc.roundedRect(x, y, w, h, cellRadius(w, h)).fill(color)
    }
  }
}

/** 2D 图例（二值色卡 / 热力竖色带） */
function drawLegend2D(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  site: ExportSiteSnapshot,
  mode: 'binary' | 'heat',
  flatBinary: boolean
): void {
  const plot = layout.plot
  const x0 = plot.x + plot.w + 16
  const available = A4_LANDSCAPE.width - PAGE_MARGIN - x0
  if (available < 30) return

  if (mode === 'binary' && !flatBinary) {
    drawText(doc, '判定', x0, plot.y + 2, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'legend',
      maxWidth: available
    }, pageNo, boxes)

    const rows: Array<{ state: number; label: string; hatch?: boolean }> = [
      { state: CELL_PASS, label: 'PASS' },
      { state: CELL_FAIL, label: 'FAIL' },
      { state: CELL_UNKNOWN, label: 'NO DATA', hatch: true }
    ]
    rows.forEach((row, i) => {
      const y = plot.y + 18 + i * 15
      const sw = 9
      if (row.hatch) {
        doc.rect(x0, y, sw, sw).fill(BINARY_PALETTE.unknownBase)
        doc.save()
        doc.rect(x0, y, sw, sw).clip()
        hatchRect(doc, x0, y, sw, sw, 4)
        doc.restore()
      } else {
        // 从下往上由暗到亮，和主图“越靠近 spec 越暗”保持同源
        const stops = binarySwatchStops(row.state, 4)
        const stepH = sw / stops.length
        stops.forEach((color, k) => {
          doc.rect(x0, y + sw - (k + 1) * stepH, sw, stepH + 0.2).fill(color)
        })
      }
      doc.lineWidth(0.4).strokeColor('rgba(147, 166, 186, 0.22)').rect(x0, y, sw, sw).stroke()
      drawText(doc, row.label, x0 + 15, y + 1, {
        size: PDF_LEGEND_FONT,
        color: CHART_STRUCTURE.legendText,
        kind: 'legend',
        maxWidth: available - 15
      }, pageNo, boxes)
    })

    drawText(doc, '明度 ∝ |margin|', x0, plot.y + 18 + rows.length * 15 + 2, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'legend',
      maxWidth: available
    }, pageNo, boxes)
    return
  }

  if (mode === 'binary' && flatBinary) {
    drawText(doc, '判定', x0, plot.y + 2, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'legend',
      maxWidth: available
    }, pageNo, boxes)
    const rows: Array<{ state: number; label: string; color: string }> = [
      { state: CELL_PASS, label: 'PASS', color: PASSFAIL_PALETTE.pass },
      { state: CELL_FAIL, label: 'FAIL', color: PASSFAIL_PALETTE.fail },
      { state: CELL_UNKNOWN, label: 'NO DATA', color: BINARY_PALETTE.unknownBase }
    ]
    rows.forEach((row, i) => {
      const y = plot.y + 18 + i * 15
      doc.rect(x0, y, 9, 9).fill(row.color)
      doc.lineWidth(0.4).strokeColor('rgba(147, 166, 186, 0.22)').rect(x0, y, 9, 9).stroke()
      drawText(doc, row.label, x0 + 15, y + 1, {
        size: PDF_LEGEND_FONT,
        color: CHART_STRUCTURE.legendText,
        kind: 'legend',
        maxWidth: available - 15
      }, pageNo, boxes)
    })
    drawText(doc, '二值判定', x0, plot.y + 18 + rows.length * 15 + 2, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'legend',
      maxWidth: available
    }, pageNo, boxes)
    return
  }

  // ---- 热力模式 ----
  const title = dataset.valueUnit
    ? `${dataset.valueLabel} (${dataset.valueUnit})`
    : dataset.valueLabel
  drawText(doc, title, x0, plot.y + 2, {
    size: PDF_LEGEND_FONT,
    color: CHART_STRUCTURE.legendMuted,
    kind: 'legend',
    maxWidth: available
  }, pageNo, boxes)

  const barHeight = Math.max(60, Math.min(150, plot.h - 70))
  const barTop = plot.y + 18
  const barWidth = 10
  const steps = heatGradientStops(24)
  const stepH = barHeight / steps.length
  steps.forEach((color, i) => {
    doc.rect(x0, barTop + barHeight - (i + 1) * stepH, barWidth, stepH + 0.2).fill(color)
  })
  doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine).rect(x0, barTop, barWidth, barHeight).stroke()

  const range = site.valueRange
  if (!range) {
    drawText(doc, '无数据', x0 + barWidth + 5, barTop + barHeight / 2 - 3, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'legend',
      maxWidth: available - barWidth - 5
    }, pageNo, boxes)
    return
  }

  const decimals = tickDecimals([range.min, range.max])
  const labelX = x0 + barWidth + 5
  const maxLabelWidth = available - barWidth - 5
  const isFlat = range.max === range.min
  drawText(doc, range.max.toFixed(decimals), labelX, barTop - 2, {
    size: PDF_LEGEND_FONT,
    color: CHART_STRUCTURE.legendText,
    kind: 'legend',
    maxWidth: maxLabelWidth
  }, pageNo, boxes)
  if (isFlat) {
    drawText(doc, '等值', labelX, barTop + barHeight / 2, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'legend',
      maxWidth: maxLabelWidth
    }, pageNo, boxes)
    return
  }
  drawText(doc, ((range.min + range.max) / 2).toFixed(decimals), labelX, barTop + barHeight / 2 - 3, {
    size: PDF_LEGEND_FONT,
    color: CHART_STRUCTURE.legendText,
    kind: 'legend',
    maxWidth: maxLabelWidth
  }, pageNo, boxes)
  drawText(doc, range.min.toFixed(decimals), labelX, barTop + barHeight - 6, {
    size: PDF_LEGEND_FONT,
    color: CHART_STRUCTURE.legendText,
    kind: 'legend',
    maxWidth: maxLabelWidth
  }, pageNo, boxes)
}

/** 2D 坐标轴：轴线 + 刻度 + 抽稀标签 + 轴标题 */
function drawAxes2D(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  geometry: ChartGeometry,
  frameOrigin: { x: number; y: number }
): void {
  const plot = layout.plot
  const xAxis = dataset.xAxis
  const yAxis = dataset.yAxis
  if (!yAxis) return

  doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
  doc.moveTo(plot.x, plot.y + plot.h + 0.25).lineTo(plot.x + plot.w, plot.y + plot.h + 0.25).stroke()

  // ---- x 轴刻度 ----
  const xDecimals = tickDecimals(xAxis.values)
  const xLabels = xAxis.values.map((value) => value.toFixed(xDecimals))
  let xLabelMax = 0
  for (const label of xLabels) xLabelMax = Math.max(xLabelMax, measure(doc, label, PDF_TICK_FONT))
  const xCenters = geometry.x.edges.slice(0, -1).map((edge, i) => {
    const rect = cellRect(geometry, i, 0)
    return frameOrigin.x + edge + rect.w / 2
  })
  // 抽稀：相邻标签中心距至少为“最宽标签 + 6pt”，避免 PDF 字体度量下互相压住
  const xIndices = pickTickIndices(xCenters, Math.max(14, xLabelMax + 6))
  for (const i of xIndices) {
    const cx = xCenters[i]
    doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
    doc.moveTo(cx, plot.y + plot.h).lineTo(cx, plot.y + plot.h + 3).stroke()

    const text = xLabels[i]
    const width = measure(doc, text, PDF_TICK_FONT)
    // 首尾贴边：宁可放弃居中，也不让标签越过图表框
    let left = cx - width / 2
    left = Math.max(layout.frame.x, Math.min(left, layout.frame.x + layout.frame.w - width))
    drawText(doc, text, left, plot.y + plot.h + 7, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.tickText,
      kind: 'tick-x'
    }, pageNo, boxes)
  }

  const xTitle = xAxis.unit ? `${xAxis.label} (${xAxis.unit})` : xAxis.label
  drawText(doc, fitText(doc, xTitle, PDF_AXIS_TITLE_FONT, plot.w), plot.x + plot.w / 2, plot.y + plot.h + 22, {
    size: PDF_AXIS_TITLE_FONT,
    color: CHART_STRUCTURE.axisTitle,
    align: 'center',
    kind: 'axis-title'
  }, pageNo, boxes)

  // ---- y 轴刻度 ----
  // y 的像素位置从上到下递增；标签宽度受左侧留白约束。
  // 左边还要塞下旋转的轴标题（宽约 8pt），因此再扣除 22pt 安全边。
  const yLabelSpace = plot.x - layout.frame.x - 22
  let yDecimals = tickDecimals(yAxis.values)
  let yLabels = yAxis.values.map((value) => value.toFixed(yDecimals))
  let yLabelMax = 0
  for (const label of yLabels) yLabelMax = Math.max(yLabelMax, measure(doc, label, PDF_TICK_FONT))
  // 放不下时先减少小数位，再换更小字号；绝不截断数值
  while (yDecimals > 0 && yLabelMax > yLabelSpace) {
    yDecimals--
    yLabels = yAxis.values.map((value) => value.toFixed(yDecimals))
    yLabelMax = 0
    for (const label of yLabels) yLabelMax = Math.max(yLabelMax, measure(doc, label, PDF_TICK_FONT))
  }
  const yFont = yLabelMax > yLabelSpace ? PDF_TICK_FONT - 1 : PDF_TICK_FONT
  const yCenters = geometry.y.edges.slice(0, -1).map((edge, i) => {
    const rect = cellRect(geometry, 0, i)
    return { y: frameOrigin.y + edge + rect.h / 2, iy: i }
  })
  const yOrder = [...yCenters].sort((a, b) => a.y - b.y)
  const yIndices = pickTickIndices(
    yOrder.map((item) => item.y),
    10
  )

  doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
  doc.moveTo(plot.x - 0.25, plot.y).lineTo(plot.x - 0.25, plot.y + plot.h).stroke()

  for (const k of yIndices) {
    const { y, iy } = yOrder[k]
    doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
    doc.moveTo(plot.x - 3, y).lineTo(plot.x, y).stroke()
    const text = yLabels[iy]
    const width = measure(doc, text, yFont)
    drawText(doc, text, plot.x - 6 - width, y - yFont / 2, {
      size: yFont,
      color: CHART_STRUCTURE.tickText,
      kind: 'tick-y'
    }, pageNo, boxes)
  }

  const yTitle = yAxis.unit ? `${yAxis.label} (${yAxis.unit})` : yAxis.label
  drawRotatedText(
    doc,
    yTitle,
    layout.frame.x + 9,
    plot.y + plot.h / 2,
    PDF_AXIS_TITLE_FONT,
    CHART_STRUCTURE.axisTitle,
    pageNo,
    boxes
  )
}

/* ------------------------------------------------------------------ *
 * 1D 页面
 * ------------------------------------------------------------------ */

/** 1D 色带高度（pt）：占绘图区 34%，夹到 42–120pt */
function bandHeight(plotHeight: number): number {
  return Math.max(42, Math.min(120, plotHeight * 0.34))
}

/** 1D 的窗口文案（与屏幕一致） */
function windowText(run: ReturnType<typeof pickPrimaryRun>, xDecimals: number, unit: string): string {
  if (!run) return '无连续 PASS 区间'
  const suffix = unit ? ` ${unit}` : ''
  return `PASS 窗口 ${run.startX.toFixed(xDecimals)} – ${run.endX.toFixed(xDecimals)}${suffix} · 宽 ${run.width.toFixed(xDecimals)}${suffix}`
}

/** 1D 图例：与屏幕同源的色卡/线型说明 */
function drawLegend1D(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  form: 'band' | 'curve',
  flatBinary: boolean
): void {
  const plot = layout.plot
  const x0 = plot.x + plot.w + 16
  const available = A4_LANDSCAPE.width - PAGE_MARGIN - x0
  if (available < 30) return
  let y = plot.y + 6

  drawText(doc, form === 'band' ? '判定' : '图例', x0, y, {
    size: PDF_LEGEND_FONT,
    color: CHART_STRUCTURE.legendMuted,
    kind: 'legend',
    maxWidth: available
  }, pageNo, boxes)
  y += 16

  const row = (draw: () => void, label: string): void => {
    draw()
    drawText(doc, label, x0 + 15, y, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendText,
      kind: 'legend',
      maxWidth: available - 15
    }, pageNo, boxes)
    y += 14
  }

  if (form === 'band') {
    const rows: Array<{ state: number; label: string }> = [
      { state: CELL_PASS, label: 'PASS' },
      { state: CELL_FAIL, label: 'FAIL' },
      { state: CELL_UNKNOWN, label: 'NO DATA' }
    ]
    for (const item of rows) {
      row(
        () => {
          if (item.state === CELL_UNKNOWN) {
            doc.rect(x0, y, 9, 9).fill(BINARY_PALETTE.unknownBase)
            doc.save()
            doc.rect(x0, y, 9, 9).clip()
            hatchRect(doc, x0, y, 9, 9, 4)
            doc.restore()
          } else {
            const color = flatBinary
              ? passFailColor(item.state)
              : binaryMarginColor(item.state, 0.5)
            doc.rect(x0, y, 9, 9).fill(color)
          }
        },
        item.label
      )
    }
    drawText(doc, flatBinary ? '二值判定' : '明度 ∝ |margin|', x0, y + 2, {
      size: PDF_LEGEND_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'legend',
      maxWidth: available
    }, pageNo, boxes)
    return
  }

  // 曲线图例：实测值 / 合格点 / 越界方向
  row(() => {
    doc.save().strokeColor('#7fd3c6').lineWidth(1.2)
    doc.moveTo(x0, y + 4).lineTo(x0 + 10, y + 4).stroke().restore()
  }, '实测值')
  row(() => {
    const color = flatBinary ? PASSFAIL_PALETTE.pass : BINARY_PALETTE.passAnchor
    doc.circle(x0 + 4.5, y + 4, 1.7).fill(color)
  }, '合格点')

  const spec = dataset.spec
  const failColor = flatBinary ? PASSFAIL_PALETTE.fail : BINARY_PALETTE.failAnchor
  const hasMin = typeof spec.min === 'number' && spec.mode !== 'none'
  const hasMax = typeof spec.max === 'number' && spec.mode !== 'none'
  const triangle = (up: boolean): void => {
    const cx = x0 + 4.5
    const cy = y + 4
    const s = 3
    if (up) {
      doc.moveTo(cx, cy - s).lineTo(cx + s * 0.92, cy + s * 0.72).lineTo(cx - s * 0.92, cy + s * 0.72)
    } else {
      doc.moveTo(cx, cy + s).lineTo(cx + s * 0.92, cy - s * 0.72).lineTo(cx - s * 0.92, cy - s * 0.72)
    }
    doc.closePath().fill(failColor)
  }
  if (hasMin && hasMax) {
    row(() => triangle(true), '超上限')
    row(() => triangle(false), '低于下限')
  } else {
    row(() => triangle(hasMax), '越界点')
  }
  row(() => {
    doc.save().strokeColor('rgba(230, 238, 247, 0.55)').lineWidth(0.6)
    doc.dash(3, { space: 2 })
    doc.moveTo(x0, y + 4).lineTo(x0 + 10, y + 4).stroke()
    doc.undash()
    doc.restore()
  }, 'SPEC 限值')
}

/** 1D 色带形态 */
function drawBandPage(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  site: ExportSiteSnapshot,
  geometry: ChartGeometry,
  frameOrigin: { x: number; y: number },
  flatBinary: boolean
): void {
  const plot = layout.plot
  const x = dataset.xAxis.values
  const nx = x.length
  const bandH = bandHeight(plot.h)
  const bandTop = plot.y + (plot.h - bandH) / 2
  const xDecimals = tickDecimals(x)
  const tint = computeMarginTints(site as SiteGrid, dataset.spec)

  const runs = findPassRuns(x, site.pass)
  const primary = pickPrimaryRun(runs)
  const boundaries = primary
    ? findRunBoundaries(x, site.value, site.pass, primary, dataset.spec)
    : []

  // 1. 窗口信息（顶部两行，超宽自动截断）
  const more = runs.length > 1 ? `  · 另有 ${runs.length - 1} 段` : ''
  drawText(
    doc,
    fitText(doc, windowText(primary, xDecimals, dataset.xAxis.unit ?? '') + more, PDF_TICK_FONT, plot.w),
    plot.x,
    plot.y + 2,
    { size: PDF_TICK_FONT, color: CHART_STRUCTURE.axisTitle, kind: 'annotation' },
    pageNo,
    boxes
  )
  if (boundaries.length > 0) {
    const unit = dataset.xAxis.unit ? ` (${dataset.xAxis.unit})` : ''
    const detailed = boundaries
      .map((b) => `${RUN_BOUNDARY_LABEL[b.role]} ${b.value.toFixed(xDecimals)}`)
      .join(' · ')
    const compact = `${boundaries.map((b) => b.value.toFixed(xDecimals)).join(' / ')}${unit}`
    const text =
      measure(doc, `${detailed}${unit}`, PDF_TICK_FONT) <= plot.w - 2
        ? `${detailed}${unit}`
        : compact
    drawText(doc, fitText(doc, text, PDF_TICK_FONT, plot.w), plot.x, plot.y + 13, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'annotation'
    }, pageNo, boxes)
  }

  // 2. 色带：每点一个圆角竖条，条间 0.75pt 格缝
  const cellTop = bandTop + CELL_GAP / 2
  const cellH = Math.max(0, bandH - CELL_GAP)
  const centers: number[] = []
  for (let ix = 0; ix < nx; ix++) {
    const left = frameOrigin.x + geometry.x.edges[ix] + CELL_GAP / 2
    const right = frameOrigin.x + geometry.x.edges[ix + 1] - CELL_GAP / 2
    const width = Math.max(0, right - left)
    centers.push((left + right) / 2)
    if (width <= 0.05) continue

    const state = site.pass[ix]
    const value = site.value[ix]
    if (state === CELL_UNKNOWN || !Number.isFinite(value)) {
      const radius = cellRadius(width, cellH)
      doc.roundedRect(left, cellTop, width, cellH, radius).fill(BINARY_PALETTE.unknownBase)
      doc.save()
      doc.roundedRect(left, cellTop, width, cellH, radius).clip()
      hatchRect(doc, left, cellTop, width, cellH)
      doc.restore()
    } else {
      const color = pdfCellColor(state, {
        flatBinary,
        mode: 'binary',
        tint: tint ? tint[ix] : 0.5,
        value,
        range: site.valueRange
      })
      doc.roundedRect(left, cellTop, width, cellH, cellRadius(width, cellH)).fill(color)
    }
  }

  // 3. 边界虚线 + 数值（奇偶交错，避免相邻边界标签压在一起）
  boundaries.forEach((boundary, order) => {
    const bx = centers[boundary.index] ?? plot.x
    dashedLine(doc, bx, bandTop - 4, bx, plot.y + plot.h, 'rgba(230, 238, 247, 0.55)', 0.6, [3, 2])
    const text = boundary.value.toFixed(xDecimals)
    const width = measure(doc, text, PDF_TICK_FONT)
    const labelY = bandTop - (order % 2 === 0 ? 12 : 21)
    let left = bx - width / 2
    left = Math.max(plot.x, Math.min(left, plot.x + plot.w - width))
    drawText(doc, text, left, labelY, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.tickText,
      kind: 'annotation'
    }, pageNo, boxes)
  })
}

/** 1D 曲线形态 */
function drawCurvePage(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  site: ExportSiteSnapshot,
  geometry: ChartGeometry,
  frameOrigin: { x: number; y: number },
  flatBinary: boolean
): void {
  const plot = layout.plot
  const x = dataset.xAxis.values
  const nx = x.length
  const tickCount = Math.max(4, Math.min(10, Math.round(plot.h / 50)))
  const scale = computeValueScale(site.value, dataset.spec, tickCount)
  if (!scale) {
    drawText(doc, '无有效测量值', plot.x + plot.w / 2, plot.y + plot.h / 2, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.legendMuted,
      align: 'center',
      kind: 'annotation'
    }, pageNo, boxes)
    return
  }

  const yDecimals = tickDecimals(scale.ticks)
  const failFill = flatBinary ? PASSFAIL_PALETTE.fail : BINARY_PALETTE.failAnchor
  const passFill = flatBinary ? PASSFAIL_PALETTE.pass : BINARY_PALETTE.passAnchor

  // 1. 横向网格 + y 刻度
  for (const tick of scale.ticks) {
    const py = valueToY(tick, scale, plot.y, plot.h)
    doc.lineWidth(0.4).strokeColor('rgba(51, 70, 90, 0.28)')
    doc.moveTo(plot.x, py).lineTo(plot.x + plot.w, py).stroke()
    doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
    doc.moveTo(plot.x - 3, py).lineTo(plot.x, py).stroke()
    const text = tick.toFixed(yDecimals)
    const width = measure(doc, text, PDF_TICK_FONT)
    drawText(doc, text, plot.x - 6 - width, py - PDF_TICK_FONT / 2, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.tickText,
      kind: 'tick-y'
    }, pageNo, boxes)
  }

  // y 轴标题（旋转）
  const yTitle = dataset.valueUnit
    ? `${dataset.valueLabel} (${dataset.valueUnit})`
    : dataset.valueLabel
  drawRotatedText(
    doc,
    yTitle,
    layout.frame.x + 9,
    plot.y + plot.h / 2,
    PDF_AXIS_TITLE_FONT,
    CHART_STRUCTURE.axisTitle,
    pageNo,
    boxes
  )

  doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
  doc.moveTo(plot.x, plot.y).lineTo(plot.x, plot.y + plot.h).stroke()

  // 2. spec 禁区底色
  const spec = dataset.spec
  if (typeof spec.max === 'number') {
    const py = valueToY(spec.max, scale, plot.y, plot.h)
    doc.save()
    doc.fillOpacity(0.07).fillColor(flatBinary ? PASSFAIL_PALETTE.fail : BINARY_PALETTE.failAnchor)
    doc.rect(plot.x, plot.y, plot.w, Math.max(0, py - plot.y)).fill()
    doc.restore()
  }
  if (typeof spec.min === 'number') {
    const py = valueToY(spec.min, scale, plot.y, plot.h)
    doc.save()
    doc.fillOpacity(0.07).fillColor(flatBinary ? PASSFAIL_PALETTE.fail : BINARY_PALETTE.failAnchor)
    doc.rect(plot.x, py, plot.w, Math.max(0, plot.y + plot.h - py)).fill()
    doc.restore()
  }

  // 3. spec 线
  const specLine = (value: number, color = 'rgba(230, 238, 247, 0.55)'): void => {
    const py = valueToY(value, scale, plot.y, plot.h)
    dashedLine(doc, plot.x, py, plot.x + plot.w, py, color, 0.6, [4, 3])
  }
  if (typeof spec.max === 'number') specLine(spec.max)
  if (typeof spec.min === 'number') specLine(spec.min)
  if (typeof spec.target === 'number') specLine(spec.target, 'rgba(56, 207, 224, 0.28)')

  // 4. 曲线（缺失点处断开；面积淡填充）
  const px = x.map((_, ix) => frameOrigin.x + cellRect(geometry, ix, 0).x + cellRect(geometry, ix, 0).w / 2)
  const segments: Array<Array<{ x: number; y: number }>> = []
  let current: Array<{ x: number; y: number }> = []
  for (let ix = 0; ix < nx; ix++) {
    const value = site.value[ix]
    if (!Number.isFinite(value)) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    current.push({ x: px[ix], y: valueToY(value, scale, plot.y, plot.h) })
  }
  if (current.length > 0) segments.push(current)

  doc.save()
  doc.rect(plot.x, plot.y, plot.w, plot.h).clip()
  for (const segment of segments) {
    if (segment.length < 2) continue
    // 面积
    doc.save()
    doc.fillOpacity(0.1).fillColor('#26968a')
    doc.moveTo(segment[0].x, plot.y + plot.h)
    for (const point of segment) doc.lineTo(point.x, point.y)
    doc.lineTo(segment[segment.length - 1].x, plot.y + plot.h)
    doc.closePath().fill()
    doc.restore()
    // 折线
    doc.save()
    doc.strokeColor('#7fd3c6').lineWidth(1.1).lineJoin('round')
    doc.moveTo(segment[0].x, segment[0].y)
    for (let i = 1; i < segment.length; i++) doc.lineTo(segment[i].x, segment[i].y)
    doc.stroke()
    doc.restore()
  }

  // 5. 采样点 / 越界三角
  const drawAllPoints = nx <= 60
  for (let ix = 0; ix < nx; ix++) {
    const value = site.value[ix]
    if (!Number.isFinite(value)) continue
    const state = site.pass[ix]
    if (state !== CELL_FAIL && !drawAllPoints) continue
    const cx = px[ix]
    const cy = valueToY(value, scale, plot.y, plot.h)
    if (state === CELL_FAIL) {
      const side = evaluatePoint(value, spec).side
      const up = side !== 'min'
      const s = 3.6
      doc.save()
      doc.fillColor('#0a0f16')
      if (up) {
        doc.moveTo(cx, cy - s).lineTo(cx + s * 0.92, cy + s * 0.72).lineTo(cx - s * 0.92, cy + s * 0.72)
      } else {
        doc.moveTo(cx, cy + s).lineTo(cx + s * 0.92, cy - s * 0.72).lineTo(cx - s * 0.92, cy - s * 0.72)
      }
      doc.closePath().fill()
      doc.fillColor(failFill)
      if (up) {
        doc.moveTo(cx, cy - s * 0.68).lineTo(cx + s * 0.62, cy + s * 0.5).lineTo(cx - s * 0.62, cy + s * 0.5)
      } else {
        doc.moveTo(cx, cy + s * 0.68).lineTo(cx + s * 0.62, cy - s * 0.5).lineTo(cx - s * 0.62, cy - s * 0.5)
      }
      doc.closePath().fill()
      doc.lineWidth(0.5).strokeColor('#ff8b84')
      if (up) {
        doc.moveTo(cx, cy - s * 0.68).lineTo(cx + s * 0.62, cy + s * 0.5).lineTo(cx - s * 0.62, cy + s * 0.5)
      } else {
        doc.moveTo(cx, cy + s * 0.68).lineTo(cx + s * 0.62, cy - s * 0.5).lineTo(cx - s * 0.62, cy - s * 0.5)
      }
      doc.closePath().stroke()
      doc.restore()
    } else if (state === CELL_PASS) {
      doc.circle(cx, cy, 1.5).fill(passFill)
    }
  }
  doc.restore()

  // 6. spec 限值标签（压在曲线上也能读清：先垫一块底色）
  const rows: Array<{ value: number; label: string }> = []
  if (typeof spec.max === 'number') rows.push({ value: spec.max, label: `SPEC MAX ${spec.max}` })
  if (typeof spec.min === 'number') rows.push({ value: spec.min, label: `SPEC MIN ${spec.min}` })
  for (const row of rows) {
    const py = valueToY(row.value, scale, plot.y, plot.h)
    const y = py - 9 >= plot.y + 22 ? py - 9 : Math.min(py + 6, plot.y + plot.h - 9)
    const width = measure(doc, row.label, PDF_TICK_FONT) + 6
    doc.save()
    doc.fillOpacity(0.72).fillColor(CHART_STRUCTURE.canvasBg)
    doc.rect(plot.x + 2, y - 2, width, PDF_TICK_FONT + 4).fill()
    doc.restore()
    drawText(doc, row.label, plot.x + 5, y, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.legendText,
      kind: 'annotation'
    }, pageNo, boxes)
  }

  // 7. 窗口信息
  const xDecimals = tickDecimals(x)
  const runs = findPassRuns(x, site.pass)
  const primary = pickPrimaryRun(runs)
  drawText(doc, fitText(doc, windowText(primary, xDecimals, dataset.xAxis.unit ?? ''), PDF_TICK_FONT, plot.w), plot.x, plot.y + 2, {
    size: PDF_TICK_FONT,
    color: CHART_STRUCTURE.axisTitle,
    kind: 'annotation'
  }, pageNo, boxes)
}

/* ------------------------------------------------------------------ *
 * 页头 / 页脚 / 章节
 * ------------------------------------------------------------------ */

/** 页眉：标题 + 副标题（站点 · spec · 判定来源）+ 右上角页码 */
function drawPageHeader(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  pageCount: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  siteLabel: string,
  subtitleExtra?: string
): void {
  const pageWidth = A4_LANDSCAPE.width
  const pageNoText = `第 ${pageNo} / ${pageCount} 页`
  const pageNoWidth = measure(doc, pageNoText, PDF_FOOTER_FONT)
  const titleMax = pageWidth - PAGE_MARGIN * 2 - pageNoWidth - 16
  drawText(doc, fitText(doc, dataset.title, PDF_HEADER_TITLE_FONT, titleMax), PAGE_MARGIN, layout.titleY, {
    size: PDF_HEADER_TITLE_FONT,
    color: CHART_STRUCTURE.axisTitle,
    kind: 'title'
  }, pageNo, boxes)

  const specText = describeSpec(dataset.spec, dataset.valueLabel, dataset.valueUnit)
  const parts = [siteLabel, specText, `判定：${describePassSource(dataset.passSource, dataset.spec)}`]
  if (subtitleExtra) parts.push(subtitleExtra)
  drawText(
    doc,
    fitText(doc, parts.join(' · '), PDF_HEADER_SUB_FONT, titleMax),
    PAGE_MARGIN,
    layout.subtitleY,
    { size: PDF_HEADER_SUB_FONT, color: CHART_STRUCTURE.tickText, kind: 'subtitle' },
    pageNo,
    boxes
  )

  drawText(doc, pageNoText, pageWidth - PAGE_MARGIN, layout.subtitleY, {
    size: PDF_FOOTER_FONT,
    color: CHART_STRUCTURE.legendMuted,
    align: 'right',
    kind: 'footer'
  }, pageNo, boxes)

  doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
  doc.moveTo(PAGE_MARGIN, layout.frame.y - 8).lineTo(pageWidth - PAGE_MARGIN, layout.frame.y - 8).stroke()
}

/** 页脚：生成时间 + 源文件名（不补造批次信息） */
function drawPageFooter(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  generatedAt: number
): void {
  const pageWidth = A4_LANDSCAPE.width
  const text = `${formatReadableTime(generatedAt)} · ${dataset.fileName}`
  const available = pageWidth - PAGE_MARGIN * 2
  drawText(doc, fitText(doc, text, PDF_FOOTER_FONT, available), PAGE_MARGIN, layout.footerY, {
    size: PDF_FOOTER_FONT,
    color: CHART_STRUCTURE.legendMuted,
    kind: 'footer'
  }, pageNo, boxes)
  doc.lineWidth(0.4).strokeColor('rgba(51, 70, 90, 0.5)')
  doc.moveTo(PAGE_MARGIN, layout.footerRuleY).lineTo(pageWidth - PAGE_MARGIN, layout.footerRuleY).stroke()
}

/** 图表框：底色 + 外框 + 站点高亮内框（与屏幕同色系） */
function drawChartFrame(doc: PDFKit.PDFDocument, layout: PdfPageLayout): void {
  const { frame, plot } = layout
  doc.rect(frame.x, frame.y, frame.w, frame.h).fill(CHART_STRUCTURE.canvasBg)
  doc.lineWidth(0.6).strokeColor(CHART_STRUCTURE.axisLine)
  doc.rect(plot.x, plot.y, plot.w, plot.h).stroke()
  doc.lineWidth(0.5).strokeColor('rgba(56, 207, 224, 0.45)')
  doc.rect(plot.x + 2.5, plot.y + 2.5, Math.max(0, plot.w - 5), Math.max(0, plot.h - 5)).stroke()
}

/* ------------------------------------------------------------------ *
 * 汇总页
 * ------------------------------------------------------------------ */

/** 汇总页：数据集基本信息 + 各站点通过率并排对比 */
function drawSummaryPage(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  pageCount: number,
  boxes: PdfTextBox[],
  request: ExportPdfRequest
): void {
  const { dataset, siteSummary } = request
  const pageWidth = A4_LANDSCAPE.width
  const contentWidth = pageWidth - PAGE_MARGIN * 2

  drawText(doc, fitText(doc, `导出汇总 · ${dataset.title}`, PDF_HEADER_TITLE_FONT + 1, contentWidth - 70), PAGE_MARGIN, layout.titleY, {
    size: PDF_HEADER_TITLE_FONT + 1,
    color: CHART_STRUCTURE.axisTitle,
    kind: 'title'
  }, pageNo, boxes)
  drawText(
    doc,
    fitText(
      doc,
      `${dataset.kind === '2d' ? '2D Shmoo' : '1D Shmoo'} · ${siteSummary.length} 个站点 · 源文件 ${dataset.fileName}`,
      PDF_HEADER_SUB_FONT,
      contentWidth - 70
    ),
    PAGE_MARGIN,
    layout.subtitleY,
    { size: PDF_HEADER_SUB_FONT, color: CHART_STRUCTURE.tickText, kind: 'subtitle' },
    pageNo,
    boxes
  )
  drawText(doc, `第 ${pageNo} / ${pageCount} 页`, pageWidth - PAGE_MARGIN, layout.subtitleY, {
    size: PDF_FOOTER_FONT,
    color: CHART_STRUCTURE.legendMuted,
    align: 'right',
    kind: 'footer'
  }, pageNo, boxes)

  // ---- 基本信息（两列） ----
  const totalKnown = siteSummary.reduce((sum, row) => sum + row.knownCount, 0)
  const totalCells = dataset.totalCells * Math.max(1, siteSummary.length)
  const missing = totalCells > 0 ? 1 - totalKnown / totalCells : 0
  const infoRows: Array<[string, string]> = [
    ['数据集类型', dataset.kind === '2d' ? '2D Shmoo' : '1D Shmoo'],
    ['网格 / 采样点', dataset.yAxis
      ? `${dataset.xAxis.values.length} × ${dataset.yAxis.values.length}`
      : `${dataset.xAxis.values.length} 点`],
    ['站点数', String(siteSummary.length)],
    ['规格', describeSpec(dataset.spec, dataset.valueLabel, dataset.valueUnit)],
    ['判定来源', describePassSource(dataset.passSource, dataset.spec)],
    ['缺失比例', `${(missing * 100).toFixed(1)}%`]
  ]
  // 只有 CSV 里真实存在的批次信息才展示（lot / wafer 等），绝不补造
  for (const item of pickLotMeta(dataset.meta).slice(0, 3)) {
    infoRows.push([item.key, item.value])
  }

  const infoTop = layout.frame.y + 2
  const columnWidth = (contentWidth - 24) / 2
  const rowH = 14
  const rowsPerColumn = Math.ceil(infoRows.length / 2)
  infoRows.forEach(([label, value], index) => {
    const column = Math.floor(index / rowsPerColumn)
    const row = index % rowsPerColumn
    const x = PAGE_MARGIN + column * (columnWidth + 24)
    const y = infoTop + row * rowH
    drawText(doc, fitText(doc, label, PDF_TICK_FONT, 56), x, y, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.legendMuted,
      kind: 'summary'
    }, pageNo, boxes)
    drawText(
      doc,
      fitText(doc, value, PDF_TICK_FONT, columnWidth - 62),
      x + 62,
      y,
      { size: PDF_TICK_FONT, color: CHART_STRUCTURE.axisTitle, kind: 'summary' },
      pageNo,
      boxes
    )
  })

  // ---- 通过率条形对比 ----
  const barsTop = infoTop + rowsPerColumn * rowH + 18
  drawText(doc, '各站点通过率', PAGE_MARGIN, barsTop, {
    size: PDF_HEADER_SUB_FONT,
    color: CHART_STRUCTURE.axisTitle,
    kind: 'summary'
  }, pageNo, boxes)

  const chartTop = barsTop + 18
  const chartBottom = layout.footerRuleY - 10
  const available = Math.max(20, chartBottom - chartTop)
  const count = Math.max(1, siteSummary.length)
  // 站点多时先压缩行高，压到 9pt 还放不下就分栏
  const rowHeight = Math.min(16, Math.max(8.5, available / count))
  const maxRows = Math.max(1, Math.floor(available / rowHeight))
  const columns = Math.ceil(count / maxRows)
  const barColumnWidth = (contentWidth - (columns - 1) * 18) / columns
  const pctWidth = 44
  // 站点标签列宽同时受比例与可用宽度约束，避免站点很多时把条形挤出页面
  const labelWidth = Math.max(
    22,
    Math.min(110, barColumnWidth * 0.3, barColumnWidth - pctWidth - 20 - 8)
  )
  const barWidth = Math.max(14, barColumnWidth - labelWidth - pctWidth - 8)

  siteSummary.forEach((row, index) => {
    const column = Math.floor(index / maxRows)
    const rowIndex = index % maxRows
    const x = PAGE_MARGIN + column * (barColumnWidth + 18)
    const y = chartTop + rowIndex * rowHeight
    const rate = row.knownCount > 0 ? row.passCount / row.knownCount : 0

    drawText(doc, fitText(doc, row.siteLabel, PDF_TICK_FONT, labelWidth - 4), x, y + 0.5, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.legendText,
      kind: 'summary'
    }, pageNo, boxes)

    const trackX = x + labelWidth
    const trackH = Math.max(4, rowHeight - 5)
    doc.rect(trackX, y + 1, barWidth, trackH).fill('rgba(147, 166, 186, 0.14)')
    if (row.knownCount > 0 && rate > 0) {
      doc.rect(trackX, y + 1, barWidth * Math.min(1, rate), trackH).fill(PASSFAIL_PALETTE.pass)
    }
    drawText(doc, formatPassRate(row.passCount, row.knownCount), x + labelWidth + barWidth + 4, y + 0.5, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.axisTitle,
      kind: 'summary'
    }, pageNo, boxes)
  })

  drawPageFooter(doc, layout, pageNo, boxes, dataset, request.generatedAt)
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 生成 PDF。
 *
 * @param request 导出请求（页序、站点快照、数据集信息）
 * @param fontBytes 已嵌入授权的 TTF 字体字节（Noto Sans SC 子集，OFL 1.1）
 * @returns PDF 字节 + 文字框审计（用于几何断言）
 */
export async function buildPdfBuffer(
  request: ExportPdfRequest,
  fontBytes: Uint8Array
): Promise<PdfBuildResult> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 0,
    autoFirstPage: false,
    info: {
      Title: request.dataset.title,
      Author: 'Shmoo Studio',
      Creator: 'Shmoo Studio 矢量导出'
    }
  })
  doc.registerFont(FONT, fontBytes)
  doc.font(FONT)

  const chunks: Buffer[] = []
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve())
    doc.on('error', (err: Error) => reject(err))
  })

  const boxes: PdfTextBox[] = []
  const layout = computePageLayout()
  const summaryPages = request.includeSummary && request.siteSummary.length > 0 ? 1 : 0
  const pageCount = request.pages.length + summaryPages
  if (pageCount === 0) {
    throw new Error('导出请求没有任何页面')
  }
  let pageNo = 0

  if (summaryPages === 1) {
    pageNo++
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 })
    doc.rect(0, 0, A4_LANDSCAPE.width, A4_LANDSCAPE.height).fill(CHART_STRUCTURE.canvasBg)
    drawSummaryPage(doc, layout, pageNo, pageCount, boxes, request)
  }

  for (const page of request.pages) {
    pageNo++
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 })
    doc.rect(0, 0, A4_LANDSCAPE.width, A4_LANDSCAPE.height).fill(CHART_STRUCTURE.canvasBg)

    drawPageHeader(
      doc,
      layout,
      pageNo,
      pageCount,
      boxes,
      request.dataset,
      page.site.siteLabel,
      page.kind === '1d'
        ? page.form === 'band'
          ? '1D 色带'
          : '1D 曲线'
        : page.mode === 'heat'
          ? '热力'
          : '二值'
    )

    drawChartFrame(doc, layout)

    const xValues = request.dataset.xAxis.values
    const yValues = request.dataset.yAxis?.values ?? [0]
    // 说明：computeGeometry 的坐标以“图表框左上角”为原点，
    // 因此绘制时统一加 frameOrigin；抽稀用的像素位置也按同一原点计算。
    const geometry = computeGeometry(layout.frame.w, layout.frame.h, {
      top: layout.plot.y - layout.frame.y,
      left: layout.plot.x - layout.frame.x,
      right: layout.frame.x + layout.frame.w - (layout.plot.x + layout.plot.w),
      bottom: layout.frame.y + layout.frame.h - (layout.plot.y + layout.plot.h)
    }, xValues, yValues)
    const frameOrigin = { x: layout.frame.x, y: layout.frame.y }

    if (page.kind === '2d') {
      const flatBinary = isFlatExportBinary(request.dataset, page)
      const mode = page.mode === 'heat' && !flatBinary ? 'heat' : 'binary'
      drawCells2D(doc, geometry, frameOrigin, page.site, request.dataset, { ...page, mode })
      drawAxes2D(doc, layout, pageNo, boxes, request.dataset, geometry, frameOrigin)
      drawLegend2D(doc, layout, pageNo, boxes, request.dataset, page.site, mode, flatBinary)
    } else {
      const flatBinary = isFlatExportBinary(request.dataset, page)
      if (page.form === 'curve') {
        drawCurvePage(doc, layout, pageNo, boxes, request.dataset, page.site, geometry, frameOrigin, flatBinary)
      } else {
        drawBandPage(doc, layout, pageNo, boxes, request.dataset, page.site, geometry, frameOrigin, flatBinary)
      }
      drawLegend1D(doc, layout, pageNo, boxes, request.dataset, page.form ?? 'band', flatBinary)
      // 1D 没有 y 轴，只需要 x 轴的刻度与轴标题
      drawXAxisOnly(doc, layout, pageNo, boxes, request.dataset, geometry, frameOrigin)
    }

    drawPageFooter(doc, layout, pageNo, boxes, request.dataset, request.generatedAt)
  }

  doc.end()
  await finished
  const bytes = Uint8Array.from(Buffer.concat(chunks))
  return { bytes, audit: { pageCount, boxes } }
}

/** 1D 数据集没有 y 轴：只画 x 轴刻度与轴标题 */
function drawXAxisOnly(
  doc: PDFKit.PDFDocument,
  layout: PdfPageLayout,
  pageNo: number,
  boxes: PdfTextBox[],
  dataset: ExportDatasetInfo,
  geometry: ChartGeometry,
  frameOrigin: { x: number; y: number }
): void {
  const plot = layout.plot
  const xAxis = dataset.xAxis
  const decimals = tickDecimals(xAxis.values)
  const labels = xAxis.values.map((value) => value.toFixed(decimals))
  let maxWidth = 0
  for (const label of labels) maxWidth = Math.max(maxWidth, measure(doc, label, PDF_TICK_FONT))
  const centers = xAxis.values.map((_, ix) => {
    const rect = cellRect(geometry, ix, 0)
    return frameOrigin.x + rect.x + rect.w / 2
  })
  const indices = pickTickIndices(centers, Math.max(14, maxWidth + 6))
  doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
  doc.moveTo(plot.x, plot.y + plot.h).lineTo(plot.x + plot.w, plot.y + plot.h).stroke()
  for (const i of indices) {
    const cx = centers[i]
    doc.lineWidth(0.5).strokeColor(CHART_STRUCTURE.axisLine)
    doc.moveTo(cx, plot.y + plot.h).lineTo(cx, plot.y + plot.h + 3).stroke()
    const text = labels[i]
    const width = measure(doc, text, PDF_TICK_FONT)
    let left = cx - width / 2
    left = Math.max(layout.frame.x, Math.min(left, layout.frame.x + layout.frame.w - width))
    drawText(doc, text, left, plot.y + plot.h + 7, {
      size: PDF_TICK_FONT,
      color: CHART_STRUCTURE.tickText,
      kind: 'tick-x'
    }, pageNo, boxes)
  }
  const title = xAxis.unit ? `${xAxis.label} (${xAxis.unit})` : xAxis.label
  drawText(doc, fitText(doc, title, PDF_AXIS_TITLE_FONT, plot.w), plot.x + plot.w / 2, plot.y + plot.h + 22, {
    size: PDF_AXIS_TITLE_FONT,
    color: CHART_STRUCTURE.axisTitle,
    align: 'center',
    kind: 'axis-title'
  }, pageNo, boxes)
}

/**
 * 导出用的“纯二值”判断。
 * 与界面口径一致：文件声明 passfail，或当前站点只有 ≤2 种不同取值。
 * 只看当前站点而不是全数据集，是因为导出可能只带一个站点（切片/单视图），
 * 这类数据本身没有连续 margin，必须使用饱和色，不能显示假的明度差。
 */
function isFlatExportBinary(dataset: ExportDatasetInfo, page: ExportChartPage): boolean {
  if (dataset.valueType === 'passfail') return true
  const seen = new Set<number>()
  for (let i = 0; i < page.site.value.length; i++) {
    const value = page.site.value[i]
    if (!Number.isFinite(value)) continue
    seen.add(value)
    if (seen.size > 2) return false
  }
  return true
}

/** 给测试/调试用的审计辅助：找出同页中的重叠文字框 */
export function findOverlappingBoxes(
  boxes: PdfTextBox[],
  kinds: Array<PdfTextBox['kind']> = ['tick-x', 'tick-y']
): Array<[PdfTextBox, PdfTextBox]> {
  const filtered = boxes.filter((box) => kinds.includes(box.kind))
  const pairs: Array<[PdfTextBox, PdfTextBox]> = []
  for (let i = 0; i < filtered.length; i++) {
    for (let j = i + 1; j < filtered.length; j++) {
      const a = filtered[i]
      const b = filtered[j]
      if (a.page === b.page && boxesOverlap(a, b, 0.2)) pairs.push([a, b])
    }
  }
  return pairs
}
