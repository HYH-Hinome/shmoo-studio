import {
  CELL_PASS,
  CELL_UNKNOWN,
  type Axis,
  type CellState,
  type ImportIssue,
  type ImportReport,
  type ShmooDataset,
  type ShmooKind,
  type SiteGrid,
  type SpecLimit,
  type ValueType
} from '../types/shmoo'
import { evaluateCell } from '../spec/evaluate'
import { parseMetadata } from './metadata'
import {
  hasDecodingDamage,
  isBlankLine,
  isCommentLine,
  splitFields,
  splitLines
} from './tokenize'
import {
  ISSUE_CODES,
  IssueCollector,
  normalizeColumnName,
  parseNumeric,
  parsePassToken
} from './validate'

/** 解析选项（测试可调阈值，避免为了触发提示而构造超大文件） */
export interface ParseOptions {
  /** 重复点策略：last（默认，后者覆盖）/ first（保留首个） */
  duplicatePolicy?: 'last' | 'first'
  /** 行数提示阈值，默认 500000（R13） */
  rowWarnThreshold?: number
  /** site 数提示阈值，默认 24（R12） */
  siteWarnThreshold?: number
}

/** 解析入参的文件信息 */
export interface ParseFileMeta {
  fileName: string
  filePath?: string | null
  fileSize?: number
  /** 外部已测得的耗时（Worker 场景下由调用方传入），不传则内部计时 */
  parseMs?: number
}

export interface ParseResult {
  /** 致命错误时为 null（错误原因见 report.issues） */
  dataset: ShmooDataset | null
  report: ImportReport
  issues: ImportIssue[]
}

/** 逐行收集的原始点 */
interface RawPoint {
  x: number
  y: number
  siteId: string
  /** pass 列解析结果；null 表示空或无法识别 */
  passToken: CellState | null
  /** 测量值；无数据为 NaN */
  value: number
}

/** 去重并升序排序（刻度值已做 12 位有效数字归一） */
function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

/** 站点排序：纯数字按数值升序，其余按本地化字符串排序 */
function sortSiteIds(ids: string[]): string[] {
  const allNumeric = ids.every((id) => id.trim() !== '' && Number.isFinite(Number(id)))
  if (allNumeric) return [...ids].sort((a, b) => Number(a) - Number(b))
  return [...ids].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}

/** 从文件名推断标题（去掉扩展名） */
function titleFromFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
}

/**
 * 解析 Shmoo CSV（长表）。
 *
 * 流程：切行 → 收集 `#` 元数据 → 定位表头 → 逐行校验 → 去重 → 建轴 → 建网格 → 三态判定。
 * 容错规则编号（R1–R17）见执行计划 3.6 节；任何致命错误都会返回 dataset = null。
 */
export function parseShmooCsv(
  text: string,
  fileMeta: ParseFileMeta,
  options: ParseOptions = {}
): ParseResult {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const collector = new IssueCollector()
  const duplicatePolicy = options.duplicatePolicy ?? 'last'
  const rowWarnThreshold = options.rowWarnThreshold ?? 500_000
  const siteWarnThreshold = options.siteWarnThreshold ?? 24

  // R14：疑似编码损坏（UTF-8 解码出现大量替换字符）
  if (hasDecodingDamage(text)) {
    collector.add('warn', ISSUE_CODES.ENCODING, '文件疑似不是 UTF-8 编码，可尝试用 GB18030 重新读取')
  }

  const lines = splitLines(text)

  // ---------- 1. 定位表头，收集元数据 ----------
  const metaLines: string[] = []
  let headerIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isBlankLine(line)) continue
    if (isCommentLine(line)) {
      metaLines.push(line)
      continue
    }
    headerIndex = i
    break
  }

  const metadata = parseMetadata(metaLines, collector)

  /** 构造空结果（致命错误路径） */
  const buildEmptyResult = (): ParseResult => {
    const issues = collector.all()
    return {
      dataset: null,
      issues,
      report: {
        fileName: fileMeta.fileName,
        fileSize: fileMeta.fileSize ?? text.length,
        parseMs: fileMeta.parseMs ?? elapsed(),
        totalRows: 0,
        validRows: 0,
        skippedRows: 0,
        duplicateRows: 0,
        sitePointCounts: {},
        missingRatio: 1,
        issues
      }
    }
  }

  const elapsed = (): number => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    return Math.round((now - startedAt) * 100) / 100
  }

  if (headerIndex < 0) {
    collector.add('error', ISSUE_CODES.NO_HEADER, '没有找到表头行（文件为空或全部是注释）')
    return buildEmptyResult()
  }

  // ---------- 2. 表头映射 ----------
  const rawHeaderFields = splitFields(lines[headerIndex])
  const columnIndex = new Map<string, number>()
  rawHeaderFields.forEach((name, index) => {
    const normalized = normalizeColumnName(name)
    if (normalized !== '' && !columnIndex.has(normalized)) columnIndex.set(normalized, index)
  })

  if (!columnIndex.has('x')) {
    collector.add('error', ISSUE_CODES.MISSING_X, '缺少必需的 x 列')
    return buildEmptyResult()
  }
  const hasYColumn = columnIndex.has('y')

  // R5：未知列（忽略但记录，便于发现导出脚本字段漂移）
  const knownColumns = new Set(['x', 'y', 'site', 'pass', 'value'])
  const unknownColumns = rawHeaderFields
    .map(normalizeColumnName)
    .filter((name) => name !== '' && !knownColumns.has(name))
  if (unknownColumns.length > 0) {
    collector.add('warn', ISSUE_CODES.UNKNOWN_COLUMN, `忽略未知列：${unknownColumns.join(', ')}`)
  }

  // ---------- 3. 逐行解析 ----------
  const points: RawPoint[] = []
  const pointIndexByKey = new Map<string, number>()
  let totalRows = 0
  let skippedRows = 0
  let duplicateRows = 0
  let sawPassToken = false
  let sawNumericValue = false

  const readField = (fields: string[], column: string): string => {
    const index = columnIndex.get(column)
    return index === undefined ? '' : (fields[index] ?? '')
  }

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (isBlankLine(line) || isCommentLine(line)) continue

    const fields = splitFields(line)
    totalRows++

    // R17：列数与表头不一致，整行跳过
    if (fields.length !== rawHeaderFields.length) {
      collector.add(
        'warn',
        ISSUE_CODES.COLUMN_MISMATCH,
        `列数与表头不一致（期望 ${rawHeaderFields.length} 列，实际 ${fields.length} 列），该行已跳过`,
        i + 1
      )
      skippedRows++
      continue
    }

    // R6：x / y 必须是数值
    const x = parseNumeric(readField(fields, 'x'))
    if (!Number.isFinite(x)) {
      collector.add('warn', ISSUE_CODES.BAD_NUMBER, 'x 不是合法数值，该行已跳过', i + 1)
      skippedRows++
      continue
    }

    let y = 0
    if (hasYColumn) {
      y = parseNumeric(readField(fields, 'y'))
      if (!Number.isFinite(y)) {
        collector.add('warn', ISSUE_CODES.BAD_NUMBER, 'y 不是合法数值，该行已跳过', i + 1)
        skippedRows++
        continue
      }
    }

    // R6：value 允许为空（表示无数据），但非空时必须能解析成数值
    const rawValue = readField(fields, 'value')
    const value = parseNumeric(rawValue)
    if (rawValue !== '' && !Number.isFinite(value)) {
      collector.add('warn', ISSUE_CODES.BAD_NUMBER, 'value 不是合法数值，该行已跳过', i + 1)
      skippedRows++
      continue
    }
    if (Number.isFinite(value)) sawNumericValue = true

    // R7：pass 值无法识别时记为未知，不丢整行
    const rawPass = readField(fields, 'pass')
    const passToken = parsePassToken(rawPass)
    if (rawPass.trim() !== '') {
      if (passToken === null) {
        collector.add('warn', ISSUE_CODES.BAD_PASS_TOKEN, `pass 值「${rawPass}」无法识别，已记为未知`, i + 1)
      } else {
        sawPassToken = true
      }
    }

    const rawSite = readField(fields, 'site')
    const siteId = rawSite === '' ? '1' : rawSite

    // R8：同一 (x, y, site) 重复
    const key = `${siteId}\u0000${x}\u0000${y}`
    const existingIndex = pointIndexByKey.get(key)
    if (existingIndex !== undefined) {
      duplicateRows++
      collector.add('warn', ISSUE_CODES.DUPLICATE_POINT, '重复点位（同 x/y/site），按策略保留其一', i + 1)
      if (duplicatePolicy === 'last') {
        points[existingIndex] = { x, y, siteId, passToken, value }
      }
      continue
    }

    pointIndexByKey.set(key, points.length)
    points.push({ x, y, siteId, passToken, value })
  }

  if (totalRows === 0) {
    collector.add('error', ISSUE_CODES.NO_DATA, '表头之后没有数据行')
    return buildEmptyResult()
  }
  if (points.length === 0) {
    collector.add('error', ISSUE_CODES.NO_DATA, '没有可用的数据点（所有行都被跳过）')
    return buildEmptyResult()
  }

  // R13：行数提示
  if (totalRows > rowWarnThreshold) {
    collector.add('info', ISSUE_CODES.LARGE_FILE, `数据行数 ${totalRows} 较大，解析与渲染可能变慢`)
  }

  // ---------- 4. 判定 1D / 2D ----------
  const declaredKind = metadata.entries['kind']?.trim().toLowerCase()
  const uniqueYValues = hasYColumn ? uniqueSorted(points.map((p) => p.y)) : []

  let kind: ShmooKind
  if (declaredKind === '1d' || declaredKind === '2d') {
    kind = declaredKind
  } else if (!hasYColumn) {
    kind = '1d'
  } else {
    kind = uniqueYValues.length <= 1 ? '1d' : '2d'
  }

  if (kind === '2d' && !hasYColumn) {
    collector.add('error', ISSUE_CODES.MISSING_Y, '2D 数据缺少必需的 y 列')
    return buildEmptyResult()
  }
  if (kind === '1d' && hasYColumn && uniqueYValues.length > 1) {
    collector.add('error', ISSUE_CODES.INCONSISTENT_1D, '声明为 1D，但 y 列存在多个取值')
    return buildEmptyResult()
  }

  // ---------- 5. 值类型与 spec ----------
  const declaredValueType = metadata.entries['value_type']?.trim().toLowerCase()
  const valueType: ValueType =
    declaredValueType === 'measured'
      ? 'measured'
      : declaredValueType === 'passfail'
        ? 'passfail'
        : // 未声明时推断：既没有可用的 pass 列、又有数值，说明是连续测量值
          !sawPassToken && sawNumericValue
          ? 'measured'
          : 'passfail'

  if (valueType === 'measured' && !sawNumericValue) {
    collector.add('error', ISSUE_CODES.EMPTY_VALUE, 'value_type 为 measured，但 value 列没有任何数值')
    return buildEmptyResult()
  }

  // D1：spec 全局共用一份，来自元数据
  const spec: SpecLimit = metadata.spec ?? { mode: 'min' }
  const passSource = metadata.entries['pass_source']?.trim().toLowerCase() === 'file' ? 'file' : 'derived'

  // R16：derived 但没有可用的 spec（缺省或显式 none）→ 全部未知，给出提示
  if (
    passSource === 'derived' &&
    valueType === 'measured' &&
    (!metadata.spec || metadata.spec.mode === 'none')
  ) {
    const message =
      metadata.spec?.mode === 'none'
        ? 'spec 为 none，不参与比较，所有点位将被判为未知'
        : '未提供 spec，所有点位将被判为未知'
    collector.add('warn', ISSUE_CODES.NO_SPEC, message)
  }

  // ---------- 6. 建轴与网格 ----------
  const xValues = uniqueSorted(points.map((p) => p.x))
  const yValues = kind === '2d' ? uniqueYValues : []
  const nx = xValues.length
  const ny = kind === '2d' ? yValues.length : 1

  const xIndex = new Map<number, number>()
  xValues.forEach((value, index) => xIndex.set(value, index))
  const yIndex = new Map<number, number>()
  yValues.forEach((value, index) => yIndex.set(value, index))

  const siteIds = sortSiteIds(Array.from(new Set(points.map((p) => p.siteId))))
  if (siteIds.length > siteWarnThreshold) {
    collector.add('info', ISSUE_CODES.MANY_SITES, `站点数 ${siteIds.length} 较多，切换器将改为可搜索下拉`)
  }

  const grids = new Map<string, SiteGrid>()
  for (const siteId of siteIds) {
    grids.set(siteId, {
      siteId,
      siteLabel: metadata.siteLabelMap[siteId] ?? `Site ${siteId}`,
      // 无数据哨兵用 NaN，三态初值必须是 UNKNOWN（不能默认成 fail）
      value: new Float32Array(nx * ny).fill(Number.NaN),
      pass: new Uint8Array(nx * ny).fill(CELL_UNKNOWN),
      valueRange: null,
      knownCount: 0,
      passCount: 0
    })
  }

  for (const point of points) {
    const grid = grids.get(point.siteId)
    if (!grid) continue
    const xi = xIndex.get(point.x)
    const yi = kind === '2d' ? yIndex.get(point.y) : 0
    if (xi === undefined || yi === undefined) continue

    const index = yi * nx + xi
    grid.value[index] = point.value

    let state: CellState
    if (valueType === 'passfail') {
      // 二值数据：以文件 pass 列为准，缺列/空值即未知
      state = point.passToken ?? CELL_UNKNOWN
    } else if (passSource === 'file' && point.passToken !== null) {
      state = point.passToken
    } else {
      // measured + derived（默认）：全部由 spec 现算
      state = evaluateCell(point.value, spec)
    }
    grid.pass[index] = state
  }

  // ---------- 7. 统计 ----------
  let totalKnown = 0
  const sitePointCounts: Record<string, number> = {}

  for (const grid of grids.values()) {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let known = 0
    let passCount = 0

    for (let i = 0; i < grid.value.length; i++) {
      const value = grid.value[i]
      if (!Number.isFinite(value)) continue
      known++
      if (value < min) min = value
      if (value > max) max = value
      if (grid.pass[i] === CELL_PASS) passCount++
    }

    grid.knownCount = known
    grid.passCount = passCount
    grid.valueRange = known > 0 ? { min, max } : null
    sitePointCounts[grid.siteId] = known

    totalKnown += known
  }

  const totalCells = nx * ny * grids.size
  const missingRatio = totalCells > 0 ? 1 - totalKnown / totalCells : 1

  const xAxis: Axis = {
    key: 'x',
    label: metadata.entries['x_label'] ?? 'X',
    unit: metadata.entries['x_unit'] ?? '',
    values: xValues,
    scale: 'linear'
  }
  const yAxis: Axis | null =
    kind === '2d'
      ? {
          key: 'y',
          label: metadata.entries['y_label'] ?? 'Y',
          unit: metadata.entries['y_unit'] ?? '',
          values: yValues,
          scale: 'linear'
        }
      : null

  const dataset: ShmooDataset = {
    id: `${fileMeta.fileName}-${Date.now()}`,
    fileName: fileMeta.fileName,
    filePath: fileMeta.filePath ?? null,
    importedAt: Date.now(),
    kind,
    meta: metadata.entries,
    title: metadata.entries['title'] ?? titleFromFileName(fileMeta.fileName),
    valueLabel: metadata.entries['value_label'] ?? 'VALUE',
    valueUnit: metadata.entries['value_unit'] ?? '',
    xAxis,
    yAxis,
    sites: siteIds.map((id) => grids.get(id) as SiteGrid),
    valueType,
    passSource,
    spec,
    issues: [],
    revision: 0
  }

  const issues = collector.all()
  dataset.issues = issues

  const report: ImportReport = {
    fileName: fileMeta.fileName,
    fileSize: fileMeta.fileSize ?? text.length,
    parseMs: fileMeta.parseMs ?? elapsed(),
    totalRows,
    validRows: points.length,
    skippedRows,
    duplicateRows,
    sitePointCounts,
    missingRatio,
    issues
  }

  return { dataset, report, issues }
}

/**
 * 供界面直接使用的小工具：整体通过率。
 * 分母只统计“已判定”的单元（pass 为 PASS/FAIL），
 * 缺测点与未配置 spec 的未知点都不计入分母，避免把“没测”算成“失败”。
 */
export function computePassRate(dataset: ShmooDataset): number | null {
  let judged = 0
  let pass = 0
  for (const site of dataset.sites) {
    for (let i = 0; i < site.pass.length; i++) {
      const state = site.pass[i]
      if (state === CELL_UNKNOWN) continue
      judged++
      if (state === CELL_PASS) pass++
    }
  }
  return judged > 0 ? pass / judged : null
}
