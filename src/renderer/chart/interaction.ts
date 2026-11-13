import type { SiteGrid, SpecLimit } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS } from '@shared/types/shmoo'
import { evaluatePoint } from '@shared/spec/evaluate'
import type { CellIndex, Rect } from './geometry'

/**
 * 交互层纯逻辑（阶段 ⑤）。
 *
 * 这里只放“可测试的数学与判定”，不碰 DOM / React / Canvas：
 *  - 浮层避让：靠近右/下边缘时翻到格子另一侧，并夹在容器内（四边都不被裁）；
 *  - 键盘移动：方向键 / Home / End 的边界夹紧；
 *  - 框选：矩形归一化与区域统计（格数、PASS/FAIL、通过率、value 范围与均值、最差 margin）；
 *  - 单击 / 双击判定：250ms 内的第二次点击才算双击，避免锁定与切片互相误触发。
 *
 * 之所以单独成文件：这些规则既有几何断言也有业务口径（例如 unknown 不算 fail），
 * 放在组件里只能靠人工点，无法在 Vitest 里稳定复现。
 */

/** 双击判定窗口（毫秒）：第二次点击间隔 ≤ 该值才算双击 */
export const DOUBLE_CLICK_MS = 250

/** 框选范围：格子索引，含端点且已归一化（ix0 ≤ ix1，iy0 ≤ iy1） */
export interface CellBox {
  ix0: number
  ix1: number
  iy0: number
  iy1: number
}

/** 框选的两个端点（拖拽起点 / 当前焦点），保持原始顺序以便 Shift+方向键扩展 */
export interface BoxSelection {
  anchor: CellIndex
  focus: CellIndex
}

/** 浮层定位结果：绝对坐标 + 是否发生了翻转（便于测试与调试） */
export interface TooltipPlacement {
  left: number
  top: number
  /** true 表示浮层放在格子的左侧（默认右侧） */
  flipX: boolean
  /** true 表示浮层放在格子的上方（默认下方） */
  flipY: boolean
}

/** 浮层尺寸（CSS 像素）：与 app.css 中 .chart-tip 的宽度、内容高度保持一致 */
export const TOOLTIP_WIDTH = 178
export const TOOLTIP_HEIGHT = 128
/** 浮层与格子的间距 */
export const TOOLTIP_OFFSET = 14
/** 浮层与容器边缘的最小留白，避免贴边被圆角裁掉 */
export const TOOLTIP_PAD = 6

/** 把格子索引夹到合法范围（网格为空时返回 {0,0}） */
export function clampCell(cell: CellIndex, nx: number, ny: number): CellIndex {
  const maxX = Math.max(0, nx - 1)
  const maxY = Math.max(0, ny - 1)
  return {
    ix: Math.min(maxX, Math.max(0, Math.round(cell.ix))),
    iy: Math.min(maxY, Math.max(0, Math.round(cell.iy)))
  }
}

/**
 * 键盘方向键移动：单元格坐标按网格夹紧，不做首尾环绕。
 * 不做环绕的理由：环绕会让“按住方向键一直推”在边界处突然跳回另一侧，
 * 读数场景下容易误读，宁可停在边上。
 */
export function moveCell(
  cell: CellIndex,
  dx: number,
  dy: number,
  nx: number,
  ny: number
): CellIndex {
  return clampCell({ ix: cell.ix + dx, iy: cell.iy + dy }, nx, ny)
}

/** Home / End：移动到当前行的行首 / 行尾（y 不变） */
export function rowEdgeCell(cell: CellIndex, edge: 'start' | 'end', nx: number): CellIndex {
  return {
    ix: edge === 'start' ? 0 : Math.max(0, nx - 1),
    iy: cell.iy
  }
}

/** 两个端点归一化成可遍历的矩形（含端点） */
export function normalizeBox(anchor: CellIndex, focus: CellIndex): CellBox {
  return {
    ix0: Math.min(anchor.ix, focus.ix),
    ix1: Math.max(anchor.ix, focus.ix),
    iy0: Math.min(anchor.iy, focus.iy),
    iy1: Math.max(anchor.iy, focus.iy)
  }
}

/** 框选区域内是否包含某个格子（用于判断框选是否需要重绘） */
export function boxContains(box: CellBox, cell: CellIndex): boolean {
  return cell.ix >= box.ix0 && cell.ix <= box.ix1 && cell.iy >= box.iy0 && cell.iy <= box.iy1
}

/** 框选区域统计结果 */
export interface BoxStats {
  /** 区域内格子总数（含缺测） */
  cells: number
  /** PASS / FAIL / 缺测格数 */
  pass: number
  fail: number
  unknown: number
  /** 通过率 = pass / (pass + fail)；没有已知格时为 null */
  passRate: number | null
  /** 有效测量值的 min / max / avg；没有有效值时为 null */
  valueMin: number | null
  valueMax: number | null
  valueAvg: number | null
  /** 区域内的最差（最小）margin；没有任何可用 margin 时为 null */
  worstMargin: number | null
}

/**
 * 统计框选区域。
 *
 * 口径与全图统计保持一致：
 *  - 缺测格计入“格子数”，但不计入 PASS/FAIL，也不参与 value 与 margin 统计；
 *  - 通过率分母只用已知格，避免缺测拉低良率；
 *  - margin 取最小值（最贴近 spec 或最负的那一格），数值口径来自 evaluatePoint，
 *    与浮层 / 规格面板同源。
 *
 * spec 必须显式传入：SiteGrid 不保存 spec（D1：spec 是数据集级、全局共用一份）。
 */
export function computeBoxStats(
  site: SiteGrid,
  nx: number,
  box: CellBox,
  spec: SpecLimit
): BoxStats {
  let pass = 0
  let fail = 0
  let unknown = 0
  let valueMin: number | null = null
  let valueMax: number | null = null
  let valueSum = 0
  let valueCount = 0
  let worstMargin: number | null = null

  for (let iy = box.iy0; iy <= box.iy1; iy++) {
    for (let ix = box.ix0; ix <= box.ix1; ix++) {
      const index = iy * nx + ix
      const state = site.pass[index]
      if (state === CELL_PASS) pass++
      else if (state === CELL_FAIL) fail++
      else unknown++

      const value = site.value[index]
      if (!Number.isFinite(value)) continue
      valueCount++
      valueSum += value
      if (valueMin === null || value < valueMin) valueMin = value
      if (valueMax === null || value > valueMax) valueMax = value

      const { margin } = evaluatePoint(value, spec)
      if (margin !== null && Number.isFinite(margin)) {
        if (worstMargin === null || margin < worstMargin) worstMargin = margin
      }
    }
  }

  return {
    cells: (box.ix1 - box.ix0 + 1) * (box.iy1 - box.iy0 + 1),
    pass,
    fail,
    unknown,
    passRate: pass + fail > 0 ? pass / (pass + fail) : null,
    valueMin,
    valueMax,
    valueAvg: valueCount > 0 ? valueSum / valueCount : null,
    worstMargin
  }
}

/**
 * 浮层避让。
 *
 * 规则：
 *  1. 默认放在格的右下方（间距 offset）；
 *  2. 右侧放不下 → 翻到左侧；下方放不下 → 翻到上方（两个方向独立判断）；
 *  3. 翻转后仍越界（格子本身贴边、容器比浮层还小）→ 夹到容器内并保留 pad 留白。
 *
 * 返回绝对 left/top，让 DOM 不必再依赖 transform 百分比，
 * 几何断言可以直接比较数字，避免“看起来对但实际溢出 1px”。
 */
export function computeTooltipPlacement(
  cell: Rect,
  container: { width: number; height: number },
  size: { width: number; height: number } = { width: TOOLTIP_WIDTH, height: TOOLTIP_HEIGHT },
  offset = TOOLTIP_OFFSET,
  pad = TOOLTIP_PAD
): TooltipPlacement {
  const maxLeft = Math.max(pad, container.width - size.width - pad)
  const maxTop = Math.max(pad, container.height - size.height - pad)

  const right = cell.x + cell.w + offset
  const leftSide = cell.x - offset - size.width
  // 默认放右侧；右侧放不下且左侧有更多空间时翻转
  const flipX = right + size.width > container.width - pad && leftSide >= pad
  const preferredLeft = flipX ? leftSide : right

  const bottom = cell.y + cell.h + offset
  const topSide = cell.y - offset - size.height
  const flipY = bottom + size.height > container.height - pad && topSide >= pad
  const preferredTop = flipY ? topSide : bottom

  return {
    left: Math.round(Math.min(maxLeft, Math.max(pad, preferredLeft))),
    top: Math.round(Math.min(maxTop, Math.max(pad, preferredTop))),
    flipX,
    flipY
  }
}

/** 一次已完成点击的记录（格子 + 时间戳） */
export interface ClickRecord {
  cell: CellIndex
  time: number
}

/** 点击判定结果：'double' 表示应切片，'single' 表示执行锁定切换 */
export type ClickVerdict = 'single' | 'double'

/**
 * 单击 / 双击判定。
 *
 * 只有“同一格 + 间隔 ≤ 250ms”的第二次点击才判为双击：
 *  - 单击锁定需要延迟 250ms 再执行，期间若来了第二次点击就取消锁定、直接切片；
 *  - 不同格子上的快速两次点击（例如连续锁两格）仍按两次单击处理，
 *    否则用户快速换格会被误判成切片。
 */
export function classifyClick(
  previous: ClickRecord | null,
  cell: CellIndex,
  now: number,
  threshold = DOUBLE_CLICK_MS
): ClickVerdict {
  if (
    previous &&
    previous.cell.ix === cell.ix &&
    previous.cell.iy === cell.iy &&
    now - previous.time >= 0 &&
    now - previous.time <= threshold
  ) {
    return 'double'
  }
  return 'single'
}
