/**
 * 导出对话框（阶段 ⑦）。
 *
 * 设计要点：
 *  - PNG 与 PDF 共用一个对话框，切换标签只改“会生成什么”，不改变当前视图；
 *  - PNG 的 2× / 3× 只影响像素密度，不影响图表区 CSS 尺寸；
 *  - PDF 的「全部 site / 汇总页」在切片视图下禁用（切片只属于当前站点）；
 *  - 保存位置交给系统保存对话框，默认目录取上次成功导出的目录（localStorage 记忆）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isFlatBinaryDataset, isHeatMeaningful } from '@shared/spec/evaluate'
import { buildExportFileName, describeSpec, formatReadableTime } from '@shared/export/format'
import { useAppStore } from '../state/store'
import { buildSliceDataset } from '../chart/slice'
import { buildPdfRequest } from '../export/request'
import { computePngPixelSize, renderExportCanvas, type PngScale } from '../export/png'

/** 上次导出目录的 localStorage 键（只存本机路径，不上传） */
const LAST_DIR_KEY = 'shmoo.export.lastDir'

/** 把字节数格式化成可读大小 */
function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function ExportDialog(): JSX.Element | null {
  const format = useAppStore((s) => s.exportFormat)
  const close = useAppStore((s) => s.openExportDialog)
  const dataset = useAppStore((s) => s.dataset)
  const activeSiteId = useAppStore((s) => s.activeSiteId)
  const colorMode = useAppStore((s) => s.colorMode)
  const oneDForm = useAppStore((s) => s.oneDForm)
  const slice = useAppStore((s) => s.slice)

  const [scale, setScale] = useState<PngScale>(2)
  const [allSites, setAllSites] = useState(false)
  const [includeSummary, setIncludeSummary] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  const [lastDir, setLastDir] = useState<string | null>(null)

  const activeSite = dataset?.sites.find((site) => site.siteId === activeSiteId) ?? null
  // 与 ChartStage 完全相同的切片口径：2D 数据集 + 当前站点 + 当前切片
  const sliceView = useMemo(
    () =>
      dataset && dataset.kind === '2d' && dataset.yAxis && activeSite && slice
        ? buildSliceDataset(dataset, activeSite, slice)
        : null,
    [dataset, activeSite, slice]
  )

  /** 读取图表区 CSS 尺寸（标题区高度在导出模块里另加） */
  useEffect(() => {
    if (!format) return
    const read = (): void => {
      const root = document.querySelector('[data-chart-root="1"]')
      if (root instanceof HTMLElement) {
        setViewport({ width: root.clientWidth, height: root.clientHeight })
      } else {
        setViewport(null)
      }
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [format, activeSiteId, slice])

  /** 每次打开重置临时选项与提示，避免上次的错误残留 */
  useEffect(() => {
    if (!format) return
    setError(null)
    setNotice(null)
    setBusy(false)
    setLastDir(localStorage.getItem(LAST_DIR_KEY))
    if (sliceView) {
      setAllSites(false)
      setIncludeSummary(false)
    }
  }, [format, sliceView])

  /** Esc 关闭（导出中不允许关闭，避免中断写盘） */
  useEffect(() => {
    if (!format) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        close(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [format, busy, close])

  const pngSize = useMemo(
    () => (viewport ? computePngPixelSize(viewport.width, viewport.height, scale) : null),
    [viewport, scale]
  )

  const handleResult = useCallback(
    (result: { canceled: boolean; filePath?: string; directory?: string; error?: string; bytes?: number }, kind: 'PNG' | 'PDF') => {
      if (result.canceled) {
        setNotice('已取消导出')
        return
      }
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.directory) {
        localStorage.setItem(LAST_DIR_KEY, result.directory)
        setLastDir(result.directory)
      }
      const message = `已导出 ${kind} · ${formatBytes(result.bytes)} · ${result.filePath ?? ''}`
      setNotice(message)
      // 状态栏同步提示，导出对话框关闭后仍能看到结果
      useAppStore.setState({ statusText: message, error: null })
      close(null)
    },
    [close]
  )

  const handleExport = useCallback(async () => {
    if (!dataset || !activeSite || !format) return
    if (!viewport || viewport.width < 40 || viewport.height < 40) {
      setError('没有找到可导出的图表区域，请先导入数据并等待图表绘制完成')
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)
    const generatedAt = Date.now()
    // 切片导出在文件名上标注 slice，避免覆盖同名 2D 导出
    const siteLabel = sliceView ? `${activeSite.siteLabel}-slice` : activeSite.siteLabel

    try {
      if (format === 'png') {
        const exportDataset = sliceView?.dataset ?? dataset
        const exportSite = sliceView?.site ?? activeSite
        const flatBinary = isFlatBinaryDataset(exportDataset)
        const mode = !flatBinary && isHeatMeaningful(exportDataset) ? colorMode : 'binary'
        const subtitle = [
          exportSite.siteLabel,
          describeSpec(exportDataset.spec, exportDataset.valueLabel, exportDataset.valueUnit),
          exportDataset.fileName,
          formatReadableTime(generatedAt)
        ].join(' · ')

        const canvas = renderExportCanvas(
          {
            dataset: exportDataset,
            site: exportSite,
            mode,
            form: sliceView ? 'curve' : oneDForm,
            flatBinary,
            width: viewport.width,
            height: viewport.height,
            scale
          },
          { subtitle }
        )

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => {
            if (value) resolve(value)
            else reject(new Error('PNG 编码失败'))
          }, 'image/png')
        })
        const data = new Uint8Array(await blob.arrayBuffer())
        const result = await window.shmoo.savePng({
          data,
          defaultFileName: buildExportFileName(dataset.title, siteLabel, generatedAt, 'png'),
          defaultDir: lastDir
        })
        handleResult(result, 'PNG')
      } else {
        // 「导出全部 site」时文件名不再带站点（否则会误以为只导了一个站）
        const fileNameSite = allSites && !sliceView ? null : siteLabel
        const request = buildPdfRequest(dataset, activeSite, {
          allSites: sliceView ? false : allSites,
          includeSummary: sliceView ? false : includeSummary,
          colorMode,
          oneDForm,
          generatedAt,
          sliceView
        })
        const result = await window.shmoo.savePdf({
          request,
          defaultFileName: buildExportFileName(dataset.title, fileNameSite, generatedAt, 'pdf'),
          defaultDir: lastDir
        })
        handleResult(result, 'PDF')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [
    dataset,
    activeSite,
    format,
    viewport,
    sliceView,
    colorMode,
    oneDForm,
    scale,
    allSites,
    includeSummary,
    lastDir,
    handleResult
  ])

  if (!format) return null

  // 图表页 + 可选汇总页（汇总页在第一页）
  const chartPageCount = dataset
    ? sliceView
      ? 1
      : allSites && format === 'pdf'
        ? dataset.sites.length
        : 1
    : 0
  const pageCount =
    chartPageCount + (format === 'pdf' && includeSummary && !sliceView ? 1 : 0)

  return (
    <div
      className="modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) close(null)
      }}
    >
      <div className="modal__panel" role="dialog" aria-modal="true" aria-label="导出图表">
        <header className="modal__head">
          <div>
            <p className="modal__eyebrow">EXPORT</p>
            <h2 className="modal__title">导出图表</h2>
          </div>
          <button type="button" className="modal__close" onClick={() => close(null)} disabled={busy} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="modal__body">
          <div className="segmented" role="group" aria-label="导出格式">
            <button
              type="button"
              className={format === 'png' ? 'is-active' : undefined}
              onClick={() => close('png')}
              disabled={busy}
            >
              PNG 位图
            </button>
            <button
              type="button"
              className={format === 'pdf' ? 'is-active' : undefined}
              onClick={() => close('pdf')}
              disabled={busy}
            >
              PDF 矢量
            </button>
          </div>

          {format === 'png' ? (
            <section className="modal__section">
              <div className="field">
                <span className="field__label">缩放倍数</span>
                <div className="segmented" role="group" aria-label="PNG 缩放倍数">
                  {[2, 3].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={scale === value ? 'is-active' : undefined}
                      onClick={() => setScale(value as PngScale)}
                      disabled={busy}
                    >
                      {value}×
                    </button>
                  ))}
                </div>
                <p className="field__hint">
                  {pngSize
                    ? `输出 ${pngSize.width} × ${pngSize.height} px（含标题区），背景为不透明画布底色`
                    : '等待图表尺寸…'}
                </p>
              </div>
              <p className="modal__note">
                仅导出静态图表：色块、坐标轴、刻度、轴标题、图例、标题。悬停浮层、锁定描边与框选矩形不会进入图片。
              </p>
            </section>
          ) : (
            <section className="modal__section">
              <label className="check">
                <input
                  type="checkbox"
                  checked={allSites}
                  disabled={busy || !!sliceView}
                  onChange={(event) => setAllSites(event.target.checked)}
                />
                <span>
                  导出全部 site
                  <em>
                    {sliceView
                      ? '切片视图只导当前曲线'
                      : `按站点顺序每站一页（共 ${dataset?.sites.length ?? 0} 个）`}
                  </em>
                </span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={includeSummary}
                  disabled={busy || !!sliceView}
                  onChange={(event) => setIncludeSummary(event.target.checked)}
                />
                <span>
                  附带汇总页
                  <em>第一页：各站点通过率并排对比 + 数据集基本信息</em>
                </span>
              </label>
              <p className="field__hint">
                A4 横向 · 图表等比缩放居中 · 共 {pageCount} 页 · 文字为矢量可选中可搜索
              </p>
              <p className="modal__note">
                噪点与 vignette 不进入矢量输出（矢量环境无意义），圆角、格缝、配色与 margin 明度调制保留。
              </p>
            </section>
          )}

          <p className="modal__dir mono" title={lastDir ?? undefined}>
            保存位置：{lastDir ? lastDir : '系统默认目录'}（可在保存对话框中更改）
          </p>

          {error ? <p className="panel__error">{error}</p> : null}
          {notice ? <p className="panel__note">{notice}</p> : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn" onClick={() => close(null)} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleExport()}
            disabled={busy || !dataset || !activeSite}
          >
            {busy ? '正在导出…' : format === 'png' ? '导出 PNG…' : '导出 PDF…'}
          </button>
        </footer>
      </div>
    </div>
  )
}
