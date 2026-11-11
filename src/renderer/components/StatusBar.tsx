import { computePassRate } from '@shared/csv/parser'
import { formatCount, formatMs, formatPercent } from '../lib/format'
import { useAppStore } from '../state/store'

/**
 * 底部状态栏。
 * 左侧：当前操作状态 / 错误。
 * 中间：导入后的真实统计（点数、site 数、通过率、缺测点、解析耗时），
 *       把“导入成功”拆成可核对的数字，避免只给一句模糊提示。
 * 右侧：版本 / 平台等只读信息。
 */
export function StatusBar(): JSX.Element {
  const statusText = useAppStore((s) => s.statusText)
  const error = useAppStore((s) => s.error)
  const appVersion = useAppStore((s) => s.appVersion)
  const platform = useAppStore((s) => s.platform)
  const dataset = useAppStore((s) => s.dataset)
  const report = useAppStore((s) => s.report)
  const fileSize = report?.fileSize ?? 0

  // 缺失单元 = 网格总格数 - 有效点数；缺失不等于失败，单独统计
  const totalCells = dataset
    ? dataset.sites.reduce((sum, site) => sum + site.value.length, 0)
    : 0
  const knownCells = dataset
    ? dataset.sites.reduce((sum, site) => sum + site.knownCount, 0)
    : 0
  const missingCells = Math.max(0, totalCells - knownCells)
  const passRate = dataset ? computePassRate(dataset) : null

  return (
    <footer className="statusbar">
      <span className="statusbar__dot" aria-hidden="true" />
      <span className="statusbar__text">{statusText}</span>
      {error ? <span className="statusbar__error">· {error}</span> : null}

      {dataset && report ? (
        <span className="statusbar__stats">
          <span className="statusbar__stat">
            点数 <span className="mono">{formatCount(report.validRows)}</span>
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            site <span className="mono">{formatCount(dataset.sites.length)}</span>
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            通过率 <span className="mono">{formatPercent(passRate)}</span>
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            缺测 <span className="mono">{formatCount(missingCells)}</span>
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            解析 <span className="mono">{formatMs(report.parseMs)}</span>
          </span>
        </span>
      ) : null}

      <span className="statusbar__spacer" />
      <span className="statusbar__meta">
        {fileSize > 0 ? (
          <span>{(fileSize / 1024).toFixed(1)} KB</span>
        ) : null}
        <span>v{appVersion}</span>
        <span>{platform}</span>
        <span>离线模式</span>
      </span>
    </footer>
  )
}
