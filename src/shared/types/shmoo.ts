/**
 * Shmoo 数据集核心类型定义（主进程 / 渲染进程共用）
 *
 * 约束：本文件及 src/shared 下的所有代码不得引用 React、DOM、Electron API，
 * 以保证解析、判定、边界算法可以在 Node 环境（Vitest）中直接单测。
 */

/** 单元格三态：0 = fail，1 = pass，2 = 无数据/未知。不能用 boolean，缺失点不等于失败 */
export type CellState = 0 | 1 | 2

export const CELL_FAIL: CellState = 0
export const CELL_PASS: CellState = 1
export const CELL_UNKNOWN: CellState = 2

/** 轴的刻度类型；v0.1 只实现 linear，log 仅保留字段 */
export type AxisScale = 'linear' | 'log'

/**
 * 一根扫描轴。
 * values 保留真实刻度（允许非均匀，例如 0.6 / 0.65 / 0.7 / 0.8），
 * 渲染时按真实值映射像素位置，不做等距假设。
 */
export interface Axis {
  /** 轴标识：x 或 y */
  key: 'x' | 'y'
  /** 显示名，如 "VDD" */
  label: string
  /** 单位，如 "V" */
  unit: string
  /** 升序去重后的刻度值 */
  values: number[]
  scale: AxisScale
}

/**
 * 规格模式：
 *  - window：双边窗口（min 与 max 同时给出；两者相等时等价于“恰好等于该值”，
 *    用于 0/1 pattern 这类离散判定）；
 *  - min / max：单边；
 *  - none：显式声明“不比较 spec”（此时所有 measued 点位为未知）。
 */
export type SpecMode = 'window' | 'min' | 'max' | 'none'

/** margin 归属的一侧：距离更近 / 被违反的那条边界 */
export type SpecSide = 'min' | 'max'

/**
 * 规格限制。按已确认决策 D1：spec 全局共用一份，挂在 ShmooDataset 顶层，
 * 不区分 site；修改后所有 site 同时重算。
 */
export interface SpecLimit {
  mode: SpecMode
  /** 下限（含） */
  min?: number
  /** 上限（含） */
  max?: number
  /** 目标值，仅用于图上参考线与 margin 展示 */
  target?: number
}

/** 单个站点的网格数据 */
export interface SiteGrid {
  /** 站点标识，统一为字符串 */
  siteId: string
  /** 站点显示名，如 SITE_A */
  siteLabel: string
  /**
   * 测量值，行优先：index = yIndex * nx + xIndex。
   * NaN 表示该单元无数据（未测），不是 0，也不是失败。
   */
  value: Float32Array
  /** 三态判定结果，长度与 value 相同 */
  pass: Uint8Array
  /** 该站点测量值的实际范围（忽略 NaN）；全部无数据时为 null */
  valueRange: { min: number; max: number } | null
  /** 已知（非 NaN）单元数 */
  knownCount: number
  /** 判定为 pass 的单元数 */
  passCount: number
}

/** 导入问题级别 */
export type IssueLevel = 'error' | 'warn' | 'info'

/** 导入过程中收集的单条问题，code 对应执行计划 3.6 节的 R1–R17 / E100+ */
export interface ImportIssue {
  level: IssueLevel
  code: string
  message: string
  /** 数据行号（1-based，含元数据行偏移），用于排错定位 */
  line?: number
  /** 同类问题聚合后的数量（仅保留前若干条明细） */
  count?: number
}

/** 数据集类型 */
export type ShmooKind = '2d' | '1d'

/** 测量值类型：连续测量值 或 二值 pass/fail */
export type ValueType = 'measured' | 'passfail'

/** 判定来源：由 spec 推导（derived）或以 CSV 的 pass 列为准（file） */
export type PassSource = 'derived' | 'file'

/** 一份完整数据集：一次导入对应一个 */
export interface ShmooDataset {
  id: string
  fileName: string
  filePath: string | null
  /** 导入时间戳（ms） */
  importedAt: number
  kind: ShmooKind
  /** 原始元数据键值对（`# key: value`），保留未识别键 */
  meta: Record<string, string>
  /** 图标题，缺省用文件名 */
  title: string
  /** 测量值显示名（如 VOH），图例与导出使用 */
  valueLabel: string
  /** 测量值单位（如 mV） */
  valueUnit: string
  xAxis: Axis
  /** 1D 数据没有 y 轴时为 null */
  yAxis: Axis | null
  /** 站点列表，顺序决定切换器顺序 */
  sites: SiteGrid[]
  valueType: ValueType
  passSource: PassSource
  /** 全局共用的 spec（D1） */
  spec: SpecLimit
  /** 导入问题列表，供导入报告面板展示 */
  issues: ImportIssue[]
  /** 数据或 spec 变更时自增，驱动派生数据重算 */
  revision: number
}

/** 单个点位的判定结果，供 hover 浮层与规格面板使用 */
export interface CellEvaluation {
  state: CellState
  /** 到最近边界的距离（与测量值同单位）；无数据或未配置 spec 时为 null */
  margin: number | null
  /** margin 占区间宽度的百分比（0–1，可为负）；无法计算时为 null */
  marginPct: number | null
  /**
   * margin 归属于哪一侧：
   *  - 单边模式恒为对应边；
   *  - 双边模式取「距下限 / 距上限中较小者」，即 margin 的来源边；
   *  - 无数据 / 未配置 spec / spec 为 none 时为 null。
   */
  side: SpecSide | null
}

/** 导入报告：阶段 ② 的解析器产出，阶段 ① 先定义结构 */
export interface ImportReport {
  fileName: string
  fileSize: number
  parseMs: number
  totalRows: number
  validRows: number
  skippedRows: number
  duplicateRows: number
  /** 每个站点的点数 */
  sitePointCounts: Record<string, number>
  /** 缺失单元格比例（0–1） */
  missingRatio: number
  issues: ImportIssue[]
}
