import type { SpecLimit, SiteGrid } from '@shared/types/shmoo'
import { CELL_UNKNOWN } from '@shared/types/shmoo'
import { evaluatePoint } from '@shared/spec/evaluate'

/**
 * 图表配色（纯函数，无 DOM 依赖）。
 *
 * 视觉方向（阶段 ③ 定调，阶段 ③c 定稿为 A′）：
 *  - 深色仪器风：底色接近黑，色块本身承担全部视觉重量，不加渐变背景/发光；
 *  - 二值模式：同源色板 + margin 明度调制（明度编码 |margin|，边界两侧同时压暗）；
 *  - 热力模式：低饱和的冷→暖顺序色带（深钢蓝 → 青 → 绿 → 琥珀），不用彩虹/jet。
 */

/** 二值模式配色定义（定稿版 A′） */
export interface BinaryPalette {
  /** PASS 色相锚点（远离 spec 时的最亮色） */
  passAnchor: string
  /** PASS 暗端（贴近 spec 时） */
  passShadow: string
  /** FAIL 色相锚点（|margin| 最大时） */
  failAnchor: string
  /** FAIL 暗端（贴近 spec 时） */
  failShadow: string
  /** 缺失格底色；斜纹在其上绘制 */
  unknownBase: string
}

/**
 * 二值配色（苹果风低饱和版）：PASS 青绿 + FAIL 红，两者都做 margin 明度调制。
 *
 * 色相取舍（在保留“青绿=通过 / 红=失效”语义的前提下压低饱和度、掺一点灰）：
 *  - PASS #3d8b80：带灰的青绿，比纯青色更接近 macOS 系统色里的“mint/teal”；
 *  - FAIL #b5564f：偏灰的砖红，不荧光、不发紫，和 PASS 并排时仍一眼可分；
 *  - 暗端仍是同色相压暗（#142523 / #2a1614），保证贴近 spec 的暗格仍能分辨红/青，
 *    不会因为降饱和而糊成同一片灰。
 */
export const BINARY_PALETTE: BinaryPalette = {
  passAnchor: '#3d8b80',
  passShadow: '#142523',
  failAnchor: '#b5564f',
  failShadow: '#2a1614',
  unknownBase: '#0e1620'
}

/** 明度调制的最暗系数：0 表示完全贴合暗端，1 表示完全贴合锚点 */
const TINT_MIN_MIX = 0.3
/** 明度调制的可用跨度 */
const TINT_SPAN = 0.7
/** 归一化 |margin| 时使用的分位数（避免极端值把整片区域压到最暗） */
const MARGIN_PERCENTILE = 0.9

/**
 * 热力色带停靠点（t = 0 表示该站点最小值，t = 1 表示最大值）。
 *
 * 设计意图（请勿“顺手统一”）：热力图的颜色编码的是**数值高低**，不是好坏，
 * 所以暖端保持琥珀 #d99a2b，不随二值模式的 FAIL 一起变红。
 * 一旦暖端也变红，用户会把“数值高”直接读成“失效”，与二值模式的红色语义冲突。
 * 二值模式的 FAIL 只由 BINARY_PALETTE.failAnchor 定义，两套色板互不影响。
 */
export const HEAT_STOPS: ReadonlyArray<{ t: number; color: string }> = [
  { t: 0, color: '#102b3f' },
  { t: 0.34, color: '#1c6478' },
  { t: 0.66, color: '#2fbf8f' },
  { t: 1, color: '#d99a2b' }
]

/** 网格线 / 轴线 / 刻度文字等“结构色”，集中在这里便于导出时复用 */
export const CHART_STRUCTURE = {
  canvasBg: '#070a0f',
  plotBg: '#0a0f16',
  axisLine: '#33465a',
  tickText: '#93a6ba',
  axisTitle: '#c3d1e0',
  legendText: '#93a6ba',
  legendMuted: '#4b6175',
  activeFrame: 'rgba(56, 207, 224, 0.45)',
  // 缺失格斜纹：20% 在 DPR=2 下几乎不可见，提高到 32%（仅出现在缺失格上）
  hatchStroke: 'rgba(147, 166, 186, 0.32)',
  crosshair: 'rgba(56, 207, 224, 0.55)',
  /** 十字准线在图框之外的部分：贯穿全图，但不抢图框内的注意力 */
  crosshairSoft: 'rgba(56, 207, 224, 0.18)',
  hoverBorder: '#6fe3ef',
  boundary: 'rgba(230, 238, 247, 0.52)',
  /** 背景 vignette：≤1.2%，且只画在色块之前 */
  vignette: 'rgba(0, 0, 0, 0.012)'
} as const

/**
 * 纯二值数据的平涂配色（无连续测量值，margin 不可用）。
 *
 * 既然没有“余量”可表达，就不做明度调制：整片用同一支颜色平涂。
 * 色值取「iOS 系统色」与「最早那版低饱和」的正中间：
 * 系统色（#34C759 / #FF3B30）在深色背景上偏刺眼，纯低饱和版又太灰，
 * 因此 PASS 用 #2DAF72、FAIL 用 #E04037——仍然一眼可分，但不扎眼。
 */
export const PASSFAIL_PALETTE = {
  pass: '#2DAF72',
  fail: '#E04037'
} as const

/** 纯二值数据取色；未知格仍然回到缺测底色，不参与红绿判定 */
export function passFailColor(state: number): string {
  if (state === 1) return PASSFAIL_PALETTE.pass
  if (state === 0) return PASSFAIL_PALETTE.fail
  return BINARY_PALETTE.unknownBase
}

/** #rrggbb → [r,g,b] */
export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized
  const num = Number.parseInt(full, 16)
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff]
}

/** [r,g,b] → #rrggbb */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** 线性插值两个颜色（sRGB 空间），t 已保证 0–1 */
export function mixColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from)
  const [r2, g2, b2] = hexToRgb(to)
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}

/**
 * 取样热力色带。
 * t 会被夹到 0–1；NaN 视为 0（调用方本不该把无数据点交进来，这里只做兜底）。
 */
export function sampleHeatColor(t: number): string {
  const stops = HEAT_STOPS
  if (!Number.isFinite(t)) return stops[0].color
  const clamped = Math.max(0, Math.min(1, t))
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (clamped >= a.t && clamped <= b.t) {
      const local = b.t === a.t ? 0 : (clamped - a.t) / (b.t - a.t)
      return mixColor(a.color, b.color, local)
    }
  }
  return stops[stops.length - 1].color
}

/**
 * 测量值 → 色带位置 0–1。
 * - 无范围（全空站点）→ 0；
 * - 全等值（min === max）→ 0.5，退化为单色（配合图例上的“等值”提示）；
 * - 正常范围 → 线性归一化并夹紧。
 */
export function valueToT(
  value: number,
  range: { min: number; max: number } | null
): number {
  if (!range || !Number.isFinite(value)) return 0
  const span = range.max - range.min
  if (!Number.isFinite(span) || span === 0) return 0.5
  return Math.max(0, Math.min(1, (value - range.min) / span))
}

/** 图例竖色带的取样数组（从下到上），供 drawStatic 与导出共用 */
export function heatGradientStops(steps = 24): string[] {
  return Array.from({ length: steps }, (_, i) => sampleHeatColor(i / (steps - 1)))
}

/**
 * 单格颜色：明度由 |margin| 归一化值 m 调制。
 *
 * 公式：color = mix(shadow, anchor, 0.30 + 0.70 × m)
 *  - m = 0（刚好贴住 spec）：只保留 30% 锚点色，色块压到最暗；
 *  - m = 1（|margin| 达到站点 p90）：完整锚点色。
 * 暗端由 shadow 显式给出，而不是简单乘 alpha，
 * 这样暗格仍然保持色相、不会因半透明与底色混出脏色。
 */
export function binaryMarginColor(state: number, m: number): string {
  if (state === CELL_UNKNOWN) return BINARY_PALETTE.unknownBase
  const anchor = state === 1 ? BINARY_PALETTE.passAnchor : BINARY_PALETTE.failAnchor
  const shadow = state === 1 ? BINARY_PALETTE.passShadow : BINARY_PALETTE.failShadow
  const clamped = Number.isFinite(m) ? Math.max(0, Math.min(1, m)) : 0
  return mixColor(shadow, anchor, TINT_MIN_MIX + TINT_SPAN * clamped)
}

/** 图例用的色卡渐变（从暗端到锚点），保证“图例与主图同源” */
export function binarySwatchStops(state: number, steps = 4): string[] {
  return Array.from({ length: steps }, (_, i) => binaryMarginColor(state, i / (steps - 1)))
}

/**
 * 计算每个格子的 |margin| 归一化值（0–1），供二值模式的明度调制使用。
 *
 * 归一化口径：
 *  - 用 evaluatePoint 的 marginPct（与 hover / 规格面板同一套 margin 语义）；
 *  - 参考值取该站点 |marginPct| 的 p90 而不是最大值，
 *    避免单个尖角把整片通过区压到暗端；
 *  - p90 为 0（所有点 margin 相同）时统一给 1，退化为纯色。
 *
 * 返回 null 表示无法计算（spec 不完整 / 全空站点），绘制时按 m = 0.5 处理。
 */
export function computeMarginTints(site: SiteGrid, spec: SpecLimit): Float32Array | null {
  const length = site.value.length
  if (length === 0) return null

  const magnitudes: number[] = []
  const raw = new Float32Array(length)
  let hasAny = false

  for (let i = 0; i < length; i++) {
    if (site.pass[i] === CELL_UNKNOWN) continue
    const { marginPct } = evaluatePoint(site.value[i], spec)
    if (marginPct === null || !Number.isFinite(marginPct)) continue
    const abs = Math.abs(marginPct)
    raw[i] = abs
    magnitudes.push(abs)
    hasAny = true
  }

  if (!hasAny || magnitudes.length === 0) return null

  magnitudes.sort((a, b) => a - b)
  const refIndex = Math.min(
    magnitudes.length - 1,
    Math.max(0, Math.round(MARGIN_PERCENTILE * (magnitudes.length - 1)))
  )
  const reference = magnitudes[refIndex]

  const tints = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    if (site.pass[i] === CELL_UNKNOWN) continue
    tints[i] = reference > 0 ? Math.min(1, raw[i] / reference) : 1
  }
  return tints
}
