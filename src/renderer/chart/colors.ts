/**
 * 图表配色（纯函数，无 DOM 依赖）。
 *
 * 视觉方向（阶段 ③ 已定）：
 *  - 深色仪器风：底色接近黑，色块本身承担全部视觉重量，不加渐变背景/发光；
 *  - 二值模式只用 pass 绿 / fail 红，与 token 中的 `--color-pass` / `--color-fail` 完全一致，
 *    避免“图里绿”和“面板里绿”不是同一种绿；
 *  - 热力模式用低饱和的冷→暖顺序色带（深钢蓝 → 青 → 绿 → 琥珀），
 *    不用彩虹/jet 配色，避免高饱和色块刺眼、也避免把“数值高低”误读成“好坏”。
 */

/** 二值模式的三态颜色 */
export const BINARY_COLORS = {
  /** 与 --color-pass（#2fbf8f）一致 */
  pass: '#2fbf8f',
  /** 与 --color-fail（#e2555a）一致 */
  fail: '#e2555a',
  /** 无数据单元格的底色，斜纹在其上绘制；比画布底稍亮，避免看起来像“空洞” */
  unknownBase: '#0d1520'
} as const

/**
 * 热力色带停靠点（t = 0 表示该站点最小值，t = 1 表示最大值）。
 * 颜色取自 token 原始层，保证与界面其它部分同源：
 *  - #102b3f 深钢蓝（自 ink-800/cyan 混合的暗部）
 *  - #1c6478 青（低值）
 *  - #2fbf8f 绿（与 pass 同色，中高值）
 *  - #d99a2b 琥珀（与 warn 同色，高值）
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
  gridLine: 'rgba(4, 6, 10, 0.45)',
  axisLine: '#33465a',
  tickText: '#93a6ba',
  axisTitle: '#c3d1e0',
  legendText: '#93a6ba',
  legendMuted: '#4b6175',
  activeFrame: 'rgba(56, 207, 224, 0.45)',
  // 缺失格斜纹：20% 在 DPR=2 下几乎不可见，提高到 32%（仅出现在缺失格上）
  hatchStroke: 'rgba(147, 166, 186, 0.32)',
  crosshair: 'rgba(56, 207, 224, 0.55)',
  hoverBorder: '#6fe3ef',
  boundary: 'rgba(230, 238, 247, 0.52)'
} as const

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
  if (!Number.isFinite(t)) return HEAT_STOPS[0].color
  const clamped = Math.max(0, Math.min(1, t))
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    const a = HEAT_STOPS[i]
    const b = HEAT_STOPS[i + 1]
    if (clamped >= a.t && clamped <= b.t) {
      const local = b.t === a.t ? 0 : (clamped - a.t) / (b.t - a.t)
      return mixColor(a.color, b.color, local)
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1].color
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

/** 三态颜色（二值模式）；未知返回底色，斜纹由绘制层叠加 */
export function binaryColor(state: number): string {
  if (state === 1) return BINARY_COLORS.pass
  if (state === 0) return BINARY_COLORS.fail
  return BINARY_COLORS.unknownBase
}
