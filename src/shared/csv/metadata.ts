import type { SpecLimit, SpecMode } from '../types/shmoo'
import { ISSUE_CODES, type IssueCollector } from './validate'

/** 元数据解析结果 */
export interface ParsedMetadata {
  /** `#!shmoo-csv 1.0` 中的版本号；没有魔数时为 null */
  version: string | null
  /** 全部 `# key: value` 键值对，key 已转小写 */
  entries: Record<string, string>
  /** site 显示名映射：siteId → label */
  siteLabelMap: Record<string, string>
  /** 从 `spec:` 解析出的全局规格；未配置时为 null */
  spec: SpecLimit | null
}

/** `spec: none` 的等价写法（大小写不敏感） */
const SPEC_NONE_TOKENS = new Set(['none', 'off', 'n/a', 'na'])

/**
 * 纯数值文本：允许正负号、小数、科学计数法。
 * 注意 `Number('720mV')` 是 NaN，这里额外区分“带单位”和“纯乱码”，
 * 以便给出更准确的错误提示。
 */
const SPEC_NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * 解析 spec 字符串，支持：
 *   none                       显式声明不比较 spec
 *   min=720                    单边下限
 *   max=860                    单边上限
 *   min=740,max=860            双边窗口
 *   min=1,max=1                零宽窗口（只接受恰好等于 1，用于 0/1 pattern）
 *
 * 约束：
 *  - 数值不得带单位（单位统一由 `value_unit` 决定，避免同一文件两套单位）；
 *  - min 与 max 同时给出且 min > max 时报错；
 *  - `none` 不能与 min/max 混用。
 *
 * 解析失败抛错，由调用方转成 SPEC 警告（不中断导入）。
 */
export function parseSpecValue(raw: string): SpecLimit {
  const trimmed = raw.trim()
  if (SPEC_NONE_TOKENS.has(trimmed.toLowerCase())) return { mode: 'none' }

  const parts = trimmed
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  const spec: SpecLimit = { mode: 'min' }

  for (const part of parts) {
    if (SPEC_NONE_TOKENS.has(part.toLowerCase())) {
      throw new Error('spec 中的 none 不能与 min/max 同时出现')
    }

    const [rawKey, rawValue] = part.split('=')
    if (rawValue === undefined) throw new Error(`spec 片段缺少等号：${part}`)
    const key = rawKey.trim().toLowerCase()
    const valueText = rawValue.trim()

    if (!SPEC_NUMBER_PATTERN.test(valueText)) {
      // 字母后缀通常意味着用户把单位写进了 spec，例如 min=720mV
      if (/[a-zA-Z]/.test(valueText)) {
        throw new Error(`spec 数值不能带单位（单位以 value_unit 为准）：${valueText}`)
      }
      throw new Error(`spec 数值非法：${part}`)
    }
    const value = Number(valueText)

    if (key === 'min') spec.min = value
    else if (key === 'max') spec.max = value
    else if (key === 'target') spec.target = value
    else throw new Error(`spec 不支持的键：${key}`)
  }

  const hasMin = typeof spec.min === 'number'
  const hasMax = typeof spec.max === 'number'
  if (!hasMin && !hasMax) throw new Error('spec 至少需要 min 或 max（或写 none）')
  if (hasMin && hasMax) {
    // min === max 合法：等价于“恰好等于该值”，用于 0/1 pattern 判定
    if ((spec.min as number) > (spec.max as number)) {
      throw new Error('spec 的 min 大于 max')
    }
    spec.mode = 'window' satisfies SpecMode
  } else {
    spec.mode = hasMin ? 'min' : 'max'
  }
  return spec
}

/**
 * 解析 `site_labels`，格式 `1=SITE_A,2=SITE_B`。
 * 非法片段直接忽略（显示名缺失不影响数据）。
 */
function parseSiteLabels(raw: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const [id, label] = part.split('=')
    if (id === undefined || label === undefined) continue
    const key = id.trim()
    const value = label.trim()
    if (key !== '' && value !== '') map[key] = value
  }
  return map
}

/**
 * 逐行解析元数据（调用方已筛出以 # 开头的行）。
 * 规则：`# key: value`；`#!shmoo-csv x.y` 为魔数与版本；无冒号的行视为普通注释忽略。
 */
export function parseMetadata(lines: string[], collector: IssueCollector): ParsedMetadata {
  const entries: Record<string, string> = {}
  let version: string | null = null

  for (const line of lines) {
    const content = line.trimStart().replace(/^#/, '').trim()
    if (content === '') continue

    // 魔数行：#!shmoo-csv 1.0
    if (content.startsWith('!shmoo-csv')) {
      version = content.slice('!shmoo-csv'.length).trim() || null
      continue
    }

    const colonIndex = content.indexOf(':')
    if (colonIndex < 0) continue // 普通注释

    const key = content.slice(0, colonIndex).trim().toLowerCase()
    const value = content.slice(colonIndex + 1).trim()
    if (key !== '') entries[key] = value
  }

  // 版本校验（R2）：只支持 1.x，更高版本继续尝试解析但给出警告
  if (version !== null && !version.startsWith('1.')) {
    collector.add('warn', ISSUE_CODES.FILE_VERSION, `文件版本 ${version} 高于当前支持的 1.x，可能缺少字段`)
  }

  const siteLabelMap = entries['site_labels'] ? parseSiteLabels(entries['site_labels']) : {}

  let spec: SpecLimit | null = null
  if (entries['spec']) {
    try {
      spec = parseSpecValue(entries['spec'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      collector.add('warn', ISSUE_CODES.BAD_SPEC, `spec 元数据无法解析：${message}`)
    }
  }

  return { version, entries, siteLabelMap, spec }
}
