/**
 * 2D Shmoo 图的几何计算（纯函数，无 DOM / React 依赖，可在 Vitest 中直接验证）。
 *
 * 设计要点（对应执行计划 4.3 节）：
 *  1. 轴的刻度使用“真实采样值”，绝不假设等距；像素位置按线性映射计算，
 *     因此非均匀轴（0.6 / 0.65 / 0.7 / 0.8）也能得到正确宽度的色块；
 *  2. 单元格边界取相邻刻度的中点，首尾各外扩半格 ——
 *     n 个采样点必须画出 n 个色块，而不是 n-1 个（常见错误）；
 *  3. 所有几何量使用 CSS 像素（逻辑像素），绘制时再由调用方按 DPR 取整，
 *     这样 hitTest / tooltip 定位都不需要关心屏幕缩放。
 */

/** 矩形（CSS 像素） */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 图表四周留白：左侧放 y 轴刻度，底部放 x 轴刻度与轴标题，右侧放图例 */
export interface ChartPadding {
  top: number
  right: number
  bottom: number
  left: number
}

/** 一根轴在画布上的几何：values 为采样值，edges 为“单元格边界”的像素位置（长度 = n + 1） */
export interface AxisGeometry {
  values: number[]
  edges: number[]
}

/** 整张图的几何信息 */
export interface ChartGeometry {
  /** 数据区（不含轴与图例） */
  plot: Rect
  /** x 轴：edges 从左到右递增 */
  x: AxisGeometry
  /** y 轴：values 升序，但 edges 从下到上对应（edges[0] 是底部） */
  y: AxisGeometry
}

/** 单元格索引 */
export interface CellIndex {
  ix: number
  iy: number
}

/** 默认留白：右侧 104px 给图例（二值两块色卡 / 热力竖色带 + 刻度） */
export const DEFAULT_PADDING: ChartPadding = { top: 20, right: 104, bottom: 48, left: 68 }

/**
 * 计算数据空间的单元格边界。
 * - 只有 1 个值时：以该值为中心、上下各 0.5 作为边界，保证仍能画出 1 个色块；
 * - 多个值时：首格向左外扩首段的一半，末格向右外扩末段的一半，中间取中点。
 * 注意：这里只处理“非递减且已去重”的输入（解析器已保证）。
 */
export function computeAxisEdges(values: number[]): number[] {
  const n = values.length
  if (n === 0) return []
  if (n === 1) return [values[0] - 0.5, values[0] + 0.5]

  const edges = new Array<number>(n + 1)
  edges[0] = values[0] - (values[1] - values[0]) / 2
  for (let i = 1; i < n; i++) {
    edges[i] = (values[i - 1] + values[i]) / 2
  }
  edges[n] = values[n - 1] + (values[n - 1] - values[n - 2]) / 2
  return edges
}

/**
 * 把数据空间的边界映射为像素位置。
 * @param invert true 表示“值越大越靠上”（y 轴），用于屏幕坐标翻转
 */
function mapEdges(
  dataEdges: number[],
  start: number,
  length: number,
  invert: boolean
): number[] {
  const span = dataEdges[dataEdges.length - 1] - dataEdges[0]
  // span 为 0 理论上不会发生（computeAxisEdges 对单值也会构造 ±0.5），这里仍做保护
  if (!Number.isFinite(span) || span === 0) {
    return dataEdges.map((_, i) => start + (length * i) / Math.max(1, dataEdges.length - 1))
  }
  return dataEdges.map((value) => {
    const t = (value - dataEdges[0]) / span
    return invert ? start + length - t * length : start + t * length
  })
}

/**
 * 计算整张图的几何。
 * 宽高过小时返回 w/h 被夹到 0 的 plot，调用方（组件）应先判断尺寸再绘制。
 */
export function computeGeometry(
  width: number,
  height: number,
  padding: ChartPadding,
  xValues: number[],
  yValues: number[]
): ChartGeometry {
  const plot: Rect = {
    x: padding.left,
    y: padding.top,
    w: Math.max(0, width - padding.left - padding.right),
    h: Math.max(0, height - padding.top - padding.bottom)
  }

  const xData = computeAxisEdges(xValues)
  const yData = computeAxisEdges(yValues)

  return {
    plot,
    x: { values: xValues, edges: mapEdges(xData, plot.x, plot.w, false) },
    // y 轴 edges[0] 对应最小值 → 画在底部
    y: { values: yValues, edges: mapEdges(yData, plot.y, plot.h, true) }
  }
}

/** 第 iy 行（y 升序）的像素上边界；行号 0 在最下方 */
export function rowTop(geometry: ChartGeometry, iy: number): number {
  return geometry.y.edges[iy + 1]
}

/** 单元格矩形（px，未取整；绘制时按 DPR 取整避免缝隙） */
export function cellRect(geometry: ChartGeometry, ix: number, iy: number): Rect {
  const left = geometry.x.edges[ix]
  const right = geometry.x.edges[ix + 1]
  const bottom = geometry.y.edges[iy]
  const top = geometry.y.edges[iy + 1]
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 单元格中心点（px），hover 时十字线与 tooltip 都吸附到这里 */
export function cellCenter(geometry: ChartGeometry, ix: number, iy: number): { x: number; y: number } {
  const rect = cellRect(geometry, ix, iy)
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/** 二分查找：返回 edges 中满足 edges[i] <= value < edges[i+1] 的下标；越界返回 -1 */
function findInterval(edges: number[], value: number): number {
  if (edges.length < 2) return -1
  const n = edges.length - 1
  if (value < edges[0] || value >= edges[n]) return -1

  let lo = 0
  let hi = n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (value < edges[mid]) hi = mid - 1
    else if (value >= edges[mid + 1]) lo = mid + 1
    else return mid
  }
  return -1
}

/**
 * 递减 edges 的二分查找（y 轴专用）。
 * y 轴因为屏幕坐标翻转，edges[0] 在底部（像素值最大）、edges[n] 在顶部（最小），
 * 所以区间条件是 edges[i+1] < value <= edges[i]。
 */
function findIntervalDesc(edges: number[], value: number): number {
  if (edges.length < 2) return -1
  const n = edges.length - 1
  if (value > edges[0] || value < edges[n]) return -1
  // 上边界恰好落在 plot.y 时归入最顶格，避免“压线无命中”
  if (value === edges[n]) return n - 1

  let lo = 0
  let hi = n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (value > edges[mid]) hi = mid - 1
    else if (value <= edges[mid + 1]) lo = mid + 1
    else return mid
  }
  return -1
}

/**
 * 命中测试：画布坐标 → 单元格索引。
 * 命中区严格限制在数据区内，鼠标在轴/图例上时返回 null（不显示十字线）。
 */
export function hitTest(geometry: ChartGeometry, px: number, py: number): CellIndex | null {
  const { plot } = geometry
  if (px < plot.x || px >= plot.x + plot.w || py < plot.y || py >= plot.y + plot.h) return null

  const ix = findInterval(geometry.x.edges, px)
  // y 轴 edges 是“底部值最大、顶部值最小”的递减数组，必须用递减查找
  const iy = findIntervalDesc(geometry.y.edges, py)
  if (ix < 0 || iy < 0) return null
  return { ix, iy }
}

/**
 * 刻度标签抽稀：按像素位置筛选，保证相邻标签间距 >= minGap。
 * 规则：
 *  - 第一个与最后一个刻度必须保留（首尾读数不能丢）；
 *  - 如果首尾本身小于 minGap，仍保留两者，由调用方缩小字号或允许轻微重叠；
 *  - 返回的是 values 的下标数组，升序。
 */
export function pickTickIndices(positions: number[], minGap = 56): number[] {
  const n = positions.length
  if (n === 0) return []
  if (n === 1) return [0]

  const picked: number[] = [0]
  let last = positions[0]
  for (let i = 1; i < n - 1; i++) {
    if (positions[i] - last >= minGap) {
      picked.push(i)
      last = positions[i]
    }
  }
  // 末尾标签：若与上一个已选标签过近，用它替换上一个，避免尾部空掉
  const lastIndex = n - 1
  if (positions[lastIndex] - last < minGap && picked.length > 1) {
    picked.pop()
  }
  picked.push(lastIndex)
  return picked
}

/**
 * 刻度标签的小数位：取“能让所有刻度都不损失精度”的最小位数（最多 4 位）。
 * 例如：
 *  - 1 / 2 / 3        → 0 位（不应显示 ".0"）
 *  - 2.0 / 2.1        → 1 位
 *  - 0.60 / 0.65      → 2 位
 *  - 0.25 / 0.50      → 2 位（不能只按 10 的幂次估算，否则会显示 0.3）
 * 用逐个位数试算，而不是 log10 近似，避免 0.1 这类步长被浮点误差推成 2 位。
 */
export function tickDecimals(values: number[]): number {
  if (values.length === 0) return 0
  for (let decimals = 0; decimals <= 4; decimals++) {
    const factor = Math.pow(10, decimals)
    const fits = values.every((value) => {
      if (!Number.isFinite(value)) return true
      const scaled = value * factor
      // 相对容差：大数值（如 1e6 级）也能正确判断
      return Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, Math.abs(scaled))
    })
    if (fits) return decimals
  }
  return 4
}
