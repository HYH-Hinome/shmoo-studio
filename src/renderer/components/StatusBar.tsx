import { computePassRate } from '@shared/csv/parser'
import { isMarginMeaningful } from '@shared/spec/evaluate'
import { formatCount, formatMs, formatPercent, formatSigned } from '../lib/format'
import { tickDecimals } from '../chart/geometry'
import { computeBoxStats, normalizeBox } from '../chart/interaction'
import { useAppStore } from '../state/store'

/**
 * 底部状态栏。
 * 左侧：当前操作状态 / 错误。
 * 中间：导入后的真实统计（点数、site 数、通过率、缺测点、解析耗时），
 *       把“导入成功”拆成可核对的数字，避免只给一句模糊提示。
 * 追加（阶段 ⑤）：框选区域统计 —— 格数、PASS/FAIL、通过率、value 范围与均值、最差 margin。
 * 右侧：版本 / 平台等只读信息。
 */
export function StatusBar(): JSX.Element {
  const statusText = useAppStore((s) => s.statusText)
  const error = useAppStore((s) => s.error)
  const appVersion = useAppStore((s) => s.appVersion)
  const platform = useAppStore((s) => s.platform)
  const dataset = useAppStore((s) => s.dataset)
  const report = useAppStore((s) => s.report)
  const activeSiteId = useAppStore((s) => s.activeSiteId)
  const box = useAppStore((s) => s.box)
  const setBox = useAppStore((s) => s.setBox)
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

  // 框选统计：直接从 store 的框选范围 + 当前站点实时计算（不缓存，spec 改动后也会跟着变）
  const activeSite = dataset?.sites.find((site) => site.siteId === activeSiteId) ?? null
  const nx = dataset?.xAxis.values.length ?? 0
  const boxStats =
    dataset && activeSite && box && nx > 0
      ? computeBoxStats(
          activeSite,
          nx,
          normalizeBox(box.anchor, box.focus),
          dataset.spec
        )
      : null
  // 二值/零宽窗口数据没有有意义的 margin：区域统计里同样写“不适用”
  const marginUsable = dataset ? isMarginMeaningful(dataset) : false
  // value 的小数位与浮层保持同一口径（2–4 位），避免区域统计和单格读数位数不一致
  const valueRange = activeSite?.valueRange ?? null
  const valueDecimals = valueRange
    ? Math.max(2, Math.min(4, tickDecimals([valueRange.min, valueRange.max]) + 1))
    : 3
  const fmtValue = (value: number | null): string =>
    value === null ? '—' : value.toFixed(valueDecimals)

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

      {boxStats ? (
        <span className="statusbar__selection" data-box-stats="1">
          <span className="statusbar__stat">
            框选 <span className="mono">{formatCount(boxStats.cells)}</span> 格
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            PASS <span className="mono">{formatCount(boxStats.pass)}</span> / FAIL{' '}
            <span className="mono">{formatCount(boxStats.fail)}</span>
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            区域通过率 <span className="mono">{formatPercent(boxStats.passRate)}</span>
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            value{' '}
            <span className="mono">
              {fmtValue(boxStats.valueMin)}–{fmtValue(boxStats.valueMax)}
            </span>{' '}
            均 <span className="mono">{fmtValue(boxStats.valueAvg)}</span>
          </span>
          <span className="statusbar__divider" aria-hidden="true" />
          <span className="statusbar__stat">
            最差 margin{' '}
            <span className="mono">
              {marginUsable ? formatSigned(boxStats.worstMargin) : '不适用'}
            </span>
          </span>
          <button
            type="button"
            className="statusbar__clear"
            onClick={() => setBox(null)}
            title="清除框选（Esc）"
          >
            清除
          </button>
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
