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

/**
 * 解析 spec 字符串，支持：
 *   min=720
 *   max=860
 *   min=740,max=860
 *   window 模式下必须同时给出 min 与 max
 * 解析失败抛错，由调用方转成 SPEC 警告（不中断导入）。
 */
export function parseSpecValue(raw: string): SpecLimit {
  const parts = raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  const spec: SpecLimit = { mode: 'min' }

  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=')
    if (rawValue === undefined) throw new Error(`spec 片段缺少等号：${part}`)
    const key = rawKey.trim().toLowerCase()
    const value = Number(rawValue.trim())
    if (!Number.isFinite(value)) throw new Error(`spec 数值非法：${part}`)

    if (key === 'min') spec.min = value
    else if (key === 'max') spec.max = value
    else if (key === 'target') spec.target = value
    else throw new Error(`spec 不支持的键：${key}`)
  }

  const hasMin = typeof spec.min === 'number'
  const hasMax = typeof spec.max === 'number'
  if (!hasMin && !hasMax) throw new Error('spec 至少需要 min 或 max')
  if (hasMin && hasMax) {
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
