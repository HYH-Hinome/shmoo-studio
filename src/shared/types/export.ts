/**
 * 导出相关的共享类型（阶段 ⑦）。
 *
 * 为什么单独定义“导出快照”而不是直接把 ShmooDataset 丢给主进程：
 *  - 主进程只负责“画”和“存”，不应该依赖渲染进程的 store / React；
 *  - 导出需要的字段是数据的子集（值、判定、范围、计数），显式列出可以避免
 *    把 issues / revision 之类的运行时字段带进导出流程；
 *  - 这些类型只包含可结构化克隆的普通对象与 TypedArray，能安全地穿过 IPC。
 */

import type { Axis, PassSource, ShmooKind, SpecLimit, ValueType } from './shmoo'

/** 单个站点的导出快照（与 SiteGrid 的字段一一对应，去掉不需要的引用） */
export interface ExportSiteSnapshot {
  siteId: string
  siteLabel: string
  /** 测量值，行优先，NaN 表示缺失 */
  value: Float32Array
  /** 三态判定：0 fail / 1 pass / 2 unknown */
  pass: Uint8Array
  /** 该站点的实际值域；全空时为 null */
  valueRange: { min: number; max: number } | null
  knownCount: number
  passCount: number
}

/** 数据集级信息：页眉、页脚、汇总页与坐标轴都用它 */
export interface ExportDatasetInfo {
  title: string
  /** 源文件名（页脚展示） */
  fileName: string
  /** 源文件绝对路径；来自内存数据时为 null（页脚只显示文件名） */
  filePath: string | null
  kind: ShmooKind
  xAxis: Axis
  yAxis: Axis | null
  valueLabel: string
  valueUnit: string
  spec: SpecLimit
  passSource: PassSource
  valueType: ValueType
  /** 网格总点数（2D = nx×ny，1D = 采样点数），用于汇总页 */
  totalCells: number
  /** CSV 元数据（只用于按需展示 lot/wafer，不做任何补造） */
  meta: Record<string, string>
}

/** 一页图表：当前视图（2D 配色 / 1D 形态）+ 该站点数据 */
export interface ExportChartPage {
  kind: '2d' | '1d'
  /** 2D 配色模式；kind=1d 时忽略 */
  mode?: 'binary' | 'heat'
  /** 1D 形态；kind=2d 时忽略 */
  form?: 'band' | 'curve'
  site: ExportSiteSnapshot
}

/** 汇总页里每个站点的一行 */
export interface ExportSiteSummaryRow {
  siteLabel: string
  passCount: number
  knownCount: number
}

/** 主进程生成 PDF 所需的全部输入 */
export interface ExportPdfRequest {
  dataset: ExportDatasetInfo
  /** 按导出顺序排列的图表页（不含汇总页） */
  pages: ExportChartPage[]
  /** 全部站点的通过率（即使只导出当前视图，也用于汇总页） */
  siteSummary: ExportSiteSummaryRow[]
  /** 是否在第一页插入汇总页 */
  includeSummary: boolean
  /** 生成时间（毫秒时间戳）；文件名与页脚共用 */
  generatedAt: number
}

/** PNG 保存请求（位图由渲染进程生成，主进程只负责落盘） */
export interface ExportPngSaveRequest {
  /** PNG 文件字节（Uint8Array，可结构化克隆） */
  data: Uint8Array
  defaultFileName: string
  /** 上次使用的目录；null 时由系统决定 */
  defaultDir: string | null
}

/** PDF 保存请求（PDF 由主进程生成并落盘） */
export interface ExportPdfSaveRequest {
  request: ExportPdfRequest
  defaultFileName: string
  defaultDir: string | null
}

/** 保存结果：取消、成功（含最终路径）或失败 */
export interface ExportSaveResult {
  canceled: boolean
  filePath?: string
  /** 最终文件所在目录，渲染进程记住它作为下次的默认目录 */
  directory?: string
  /** 失败原因（未取消但写入失败时给出） */
  error?: string
  /** 写入的字节数（成功时给出，便于报告与自检） */
  bytes?: number
}
