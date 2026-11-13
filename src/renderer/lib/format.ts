/**
 * 界面展示用的数字格式化工具。
 * 统一口径，避免各个组件各写一套 toFixed 导致同屏数字位数不一致。
 */

/** 整数千分位；空值/非法值返回占位符 */
export function formatCount(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback
  return Math.round(value).toLocaleString('en-US')
}

/**
 * 百分比：输入 0–1 的比例，输出 "48.3%"。
 * 比例非法（null / NaN）时返回占位符，绝不显示 "NaN%"。
 */
export function formatPercent(ratio: number | null | undefined, digits = 1, fallback = '—'): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return fallback
  return `${(ratio * 100).toFixed(digits)}%`
}

/**
 * 带符号的测量值（margin 用）：正数补 "+"，让“在规格内/外”一眼可读。
 * 小数位默认 1 位，与样例里的 mV 量级匹配。
 */
export function formatSigned(value: number | null | undefined, digits = 1, fallback = '—'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback
  const fixed = value.toFixed(digits)
  return value > 0 ? `+${fixed}` : fixed
}

/** 解析耗时：小于 1ms 时保留两位小数，其余保留一位，单位 ms */
export function formatMs(ms: number | null | undefined, fallback = '—'): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return fallback
  if (ms < 1) return `${ms.toFixed(2)} ms`
  return `${ms.toFixed(1)} ms`
}
