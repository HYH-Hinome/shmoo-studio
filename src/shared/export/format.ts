/**
 * 导出文案与文件名的纯函数（阶段 ⑦）。
 *
 * 放在 shared 的原因：渲染进程要用它生成本地文件名/对话框文案，
 * 主进程要用它写页眉页脚；两边必须完全一致，不能各写一份。
 * 本文件不引用 DOM / Electron，可在 Vitest 中直接断言。
 */

import type { PassSource, SpecLimit } from '../types/shmoo'
import { isZeroWidthWindow } from '../spec/evaluate'

/** 把日期补零 */
function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/**
 * 生成文件名用的时间戳：`YYYYMMDD-HHmmss`（本地时间）。
 * 不包含毫秒，避免文件名过长；同一秒内重复导出由系统对话框自行覆盖确认。
 */
export function formatFileStamp(at: number): string {
  const date = new Date(at)
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 可读的生成时间：`YYYY-MM-DD HH:mm:ss`（本地时间，页脚使用） */
export function formatReadableTime(at: number): string {
  const date = new Date(at)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** Windows / macOS / Linux 文件名里都不能出现的字符（统一按最严格的处理） */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * 清洗文件名主干：去掉非法字符、折叠空白、裁剪长度。
 * 不在这里补扩展名，由调用方决定（PNG / PDF）。
 */
export function sanitizeFileBase(name: string): string {
  const cleaned = name.replace(ILLEGAL_FILENAME_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const base = cleaned.length > 0 ? cleaned : 'shmoo-export'
  // 留出站点名与时间戳的位置，避免超过 Windows 260 字符路径限制
  return base.slice(0, 80)
}

/**
 * 生成默认文件名：`数据集名_站点_时间戳.扩展名`。
 * 站点为空（例如汇总导出）时省略中段，避免出现连续下划线。
 */
export function buildExportFileName(
  datasetTitle: string,
  siteLabel: string | null,
  at: number,
  extension: 'png' | 'pdf'
): string {
  const base = sanitizeFileBase(datasetTitle)
  const site = siteLabel ? `_${sanitizeFileBase(siteLabel)}` : ''
  return `${base}${site}_${formatFileStamp(at)}.${extension}`
}

/**
 * spec 描述：与界面顶部 facts 的文案保持一致。
 * 未配置 spec 时明确写出“未配置”，绝不静默显示一个看起来像默认值的数字。
 */
export function describeSpec(spec: SpecLimit, valueLabel: string, valueUnit: string): string {
  const unit = valueUnit ? ` ${valueUnit}` : ''
  if (isZeroWidthWindow(spec)) {
    return `${valueLabel} = ${spec.min}${unit}`.trim()
  }
  if (spec.mode === 'window' && typeof spec.min === 'number' && typeof spec.max === 'number') {
    return `${spec.min} ≤ ${valueLabel} ≤ ${spec.max}${unit}`.trim()
  }
  if (spec.mode === 'min' && typeof spec.min === 'number') {
    return `${valueLabel} ≥ ${spec.min}${unit}`.trim()
  }
  if (spec.mode === 'max' && typeof spec.max === 'number') {
    return `${valueLabel} ≤ ${spec.max}${unit}`.trim()
  }
  if (spec.mode === 'none') return 'spec: none（不参与比较）'
  return '未配置 spec'
}

/** 判定来源文案（页眉副标题 / 汇总页使用） */
export function describePassSource(source: PassSource, spec: SpecLimit): string {
  if (source === 'file') return 'CSV pass 列'
  if (spec.mode === 'none') return 'spec: none'
  return 'spec 推导'
}

/**
 * 通过率文案：分母只用“已知点”，缺失点不算失败。
 * known = 0 时显示 “—” 而不是 0%，避免误读成全军覆没。
 */
export function formatPassRate(passCount: number, knownCount: number): string {
  if (knownCount <= 0) return '—'
  return `${((passCount / knownCount) * 100).toFixed(1)}%`
}

/**
 * 从 CSV 元数据中挑出“批次类”信息（lot / wafer / 批次 / 晶圆 …）。
 * 只挑 CSV 里真实存在的键，不补造任何值；没有就返回空数组。
 */
export function pickLotMeta(meta: Record<string, string>): Array<{ key: string; value: string }> {
  const pattern = /lot|wafer|批次|晶圆|片号/i
  return Object.entries(meta)
    .filter(([key, value]) => pattern.test(key) && value.trim().length > 0)
    .map(([key, value]) => ({ key, value: value.trim() }))
}
