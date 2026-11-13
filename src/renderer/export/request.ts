/**
 * 把界面状态整理成导出请求（阶段 ⑦）。
 *
 * 这里只做“取数 + 组装”，不画图、不读写文件：
 *  - PDF 请求交给主进程的 pdfkit 生成（矢量）；
 *  - PNG 请求交给 renderer/export/png.ts 离屏绘制。
 * 快照只保留导出需要的字段，避免把 revision / issues 等运行时字段带进 IPC。
 */

import type { ShmooDataset, SiteGrid } from '../../shared/types/shmoo'
import type {
  ExportChartPage,
  ExportDatasetInfo,
  ExportPdfRequest,
  ExportSiteSnapshot,
  ExportSiteSummaryRow
} from '../../shared/types/export'
import { isFlatBinaryDataset } from '@shared/spec/evaluate'
import type { ColorMode, OneDForm } from '../state/store'

/** 单个站点的导出快照 */
export function snapshotSite(site: SiteGrid): ExportSiteSnapshot {
  return {
    siteId: site.siteId,
    siteLabel: site.siteLabel,
    value: site.value,
    pass: site.pass,
    valueRange: site.valueRange,
    knownCount: site.knownCount,
    passCount: site.passCount
  }
}

/** 数据集级导出信息 */
export function snapshotDataset(dataset: ShmooDataset): ExportDatasetInfo {
  const nx = dataset.xAxis.values.length
  const ny = dataset.yAxis ? dataset.yAxis.values.length : 1
  return {
    title: dataset.title,
    fileName: dataset.fileName,
    filePath: dataset.filePath,
    kind: dataset.kind,
    xAxis: dataset.xAxis,
    yAxis: dataset.yAxis,
    valueLabel: dataset.valueLabel,
    valueUnit: dataset.valueUnit,
    spec: dataset.spec,
    passSource: dataset.passSource,
    valueType: dataset.valueType,
    totalCells: nx * ny,
    meta: dataset.meta
  }
}

/** 全部站点的通过率（汇总页用） */
export function buildSiteSummary(dataset: ShmooDataset): ExportSiteSummaryRow[] {
  return dataset.sites.map((site) => ({
    siteLabel: site.siteLabel,
    passCount: site.passCount,
    knownCount: site.knownCount
  }))
}

export interface BuildPdfOptions {
  /** 导出全部 site（每站一页）；false 时只导当前 site */
  allSites: boolean
  /** 是否插入汇总页（切片视图下会被强制关闭） */
  includeSummary: boolean
  /** 2D 当前配色模式 */
  colorMode: ColorMode
  /** 1D 当前形态 */
  oneDForm: OneDForm
  /** 当前生成时间，测试可注入固定值 */
  generatedAt?: number
  /**
   * 切片视图：非 null 时导出这条切片曲线（1D），
   * 不再提供“全部 site / 汇总页”（切片只属于当前站点）。
   */
  sliceView?: { dataset: ShmooDataset; site: SiteGrid } | null
}

/**
 * 组装 PDF 导出请求。
 *
 * 页面顺序：
 *  - 切片视图：只有 1 页（当前切片曲线）；
 *  - allSites：按 dataset.sites 的原始顺序，每站一页；
 *  - 否则：只有当前站点一页。
 */
export function buildPdfRequest(
  dataset: ShmooDataset,
  activeSite: SiteGrid,
  options: BuildPdfOptions
): ExportPdfRequest {
  const generatedAt = options.generatedAt ?? Date.now()
  const flatBinary = isFlatBinaryDataset(dataset)
  const pages: ExportChartPage[] = []

  if (options.sliceView) {
    pages.push({
      kind: '1d',
      form: 'curve',
      site: snapshotSite(options.sliceView.site)
    })
    return {
      dataset: snapshotDataset(options.sliceView.dataset),
      pages,
      siteSummary: buildSiteSummary(dataset),
      // 切片视图只导当前这条曲线；汇总页在界面上也已被禁用
      includeSummary: false,
      generatedAt
    }
  }

  if (dataset.kind === '2d') {
    const mode = flatBinary ? 'binary' : options.colorMode
    const sites = options.allSites ? dataset.sites : [activeSite]
    for (const site of sites) {
      pages.push({ kind: '2d', mode, site: snapshotSite(site) })
    }
  } else {
    const sites = options.allSites ? dataset.sites : [activeSite]
    for (const site of sites) {
      pages.push({ kind: '1d', form: options.oneDForm, site: snapshotSite(site) })
    }
  }

  return {
    dataset: snapshotDataset(dataset),
    pages,
    siteSummary: buildSiteSummary(dataset),
    includeSummary: options.includeSummary,
    generatedAt
  }
}
