/**
 * 矢量 PDF 的版式计算（阶段 ⑦，单位：pt）。
 *
 * 与屏幕上的 Canvas 版式分开计算的原因：
 *  - PDF 没有“设备像素比”，纸张尺寸固定；
 *  - 字体度量来自嵌入字体（pdfkit / fontkit），与浏览器 Canvas 的 measureText 不完全一致，
 *    轴刻度必须按 PDF 自己的文字宽度重新抽稀，否则会出现标签重叠或越界；
 *  - 版式在这里集中定义，绘制代码只消费矩形，便于测试直接断言“文字框是否重叠/越界”。
 */

/** A4 横向（pt）。PDF 的 1pt = 1/72 inch */
export const A4_LANDSCAPE = { width: 841.89, height: 595.28 } as const

/** 页边距：四周留白足够装订与打印，同时给页眉页脚留位置 */
export const PAGE_MARGIN = 36

/** 轴标题与刻度字号（pt）；比屏幕 10px 略小，打印后仍清晰 */
export const PDF_TICK_FONT = 7
export const PDF_AXIS_TITLE_FONT = 7.5
export const PDF_LEGEND_FONT = 7
export const PDF_HEADER_TITLE_FONT = 15
export const PDF_HEADER_SUB_FONT = 8.5
export const PDF_FOOTER_FONT = 7

/** 图表框四周内缩：左边给 y 刻度、下边给 x 刻度与轴标题、右边给图例、上边留呼吸 */
export const PLOT_INSET = { top: 16, right: 100, bottom: 38, left: 58 } as const

/** 矩形（左上角原点，y 向下；与 pdfkit 的坐标系一致） */
export interface PdfRect {
  x: number
  y: number
  w: number
  h: number
}

/** 一页的版式：页眉、图表框、数据区、页脚 */
export interface PdfPageLayout {
  /** 页眉标题基线（文字顶部） */
  titleY: number
  /** 页眉副标题顶部 */
  subtitleY: number
  /** 图表框（含轴与图例的整块） */
  frame: PdfRect
  /** 数据区（色块 + 内部网格） */
  plot: PdfRect
  /** 页脚文字顶部 */
  footerY: number
  /** 页脚分隔线 y */
  footerRuleY: number
}

/**
 * 计算一页的版式。
 * 页眉固定占 2 行（标题 + 副标题），页脚一行 + 一条细分隔线；
 * 中间剩余高度全部交给图表框，保证一页一张图、等比例铺满可用空间。
 */
export function computePageLayout(
  pageWidth = A4_LANDSCAPE.width,
  pageHeight = A4_LANDSCAPE.height
): PdfPageLayout {
  const titleY = 26
  const subtitleY = 47
  // 页眉底线（副标题下 10pt）之后才是图表
  const frameTop = 66
  const footerY = pageHeight - 26
  const footerRuleY = footerY - 8
  const frame: PdfRect = {
    x: PAGE_MARGIN,
    y: frameTop,
    w: Math.max(0, pageWidth - PAGE_MARGIN * 2),
    h: Math.max(0, footerRuleY - 10 - frameTop)
  }
  const plot: PdfRect = {
    x: frame.x + PLOT_INSET.left,
    y: frame.y + PLOT_INSET.top,
    w: Math.max(0, frame.w - PLOT_INSET.left - PLOT_INSET.right),
    h: Math.max(0, frame.h - PLOT_INSET.top - PLOT_INSET.bottom)
  }
  return { titleY, subtitleY, frame, plot, footerY, footerRuleY }
}

/** 文字框（审计用）：x/y 为左上角，h 取字号高度 */
export interface PdfTextBox {
  /** 第几页（从 1 开始，汇总页也是 1） */
  page: number
  /** 语义分类，便于测试只挑某几类做重叠断言 */
  kind:
    | 'title'
    | 'subtitle'
    | 'footer'
    | 'tick-x'
    | 'tick-y'
    | 'axis-title'
    | 'legend'
    | 'summary'
    | 'annotation'
  text: string
  x: number
  y: number
  w: number
  h: number
  /** 胶囊/条带等非文字块的附加标识；文字框恒为 undefined */
  note?: string
}

/**
 * 判断两个文字框是否重叠（带 gap 容差）。
 * 容差用于允许“紧邻但不交叠”：例如两个刻度只差 0.2pt 的边界接触。
 */
export function boxesOverlap(a: PdfTextBox, b: PdfTextBox, gap = 0): boolean {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  )
}

/** 文字框是否完整落在页面可用区域内（页面四边各留 PAGE_MARGIN/2 的安全边） */
export function boxInsidePage(
  box: PdfTextBox,
  pageWidth = A4_LANDSCAPE.width,
  pageHeight = A4_LANDSCAPE.height
): boolean {
  const safe = PAGE_MARGIN / 2
  return (
    box.x >= safe &&
    box.y >= safe &&
    box.x + box.w <= pageWidth - safe &&
    box.y + box.h <= pageHeight - safe
  )
}
