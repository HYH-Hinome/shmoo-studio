import { formatCount, formatPercent } from '../lib/format'
import { useAppStore } from '../state/store'

/**
 * 左侧站点栏。
 * 按决策 D2：一个 site 一张图，站点数量完全由数据决定，这里不再写死。
 * 点击某个 site 只切换“当前要看哪一张图”，不会做多 site 叠加。
 * 按 R11：只有 1 个 site 时不显示切换器，改为一行只读说明，避免出现无意义的“Site 1”按钮。
 */
export function SiteRail(): JSX.Element {
  const dataset = useAppStore((s) => s.dataset)
  const activeSiteId = useAppStore((s) => s.activeSiteId)
  const setActiveSite = useAppStore((s) => s.setActiveSite)
  const fileName = useAppStore((s) => s.fileName)
  const report = useAppStore((s) => s.report)
  const sites = dataset?.sites ?? []

  // 网格尺寸：1D 没有 y 轴，按 1 行计算，保证“30 × 1”这类读数仍然直观
  const nx = dataset?.xAxis.values.length ?? 0
  const ny = dataset?.yAxis?.values.length ?? (dataset ? 1 : 0)

  return (
    <aside className="rail" aria-label="站点列表">
      <div className="rail__head">
        <span>站点</span>
        <span className="rail__count mono">{sites.length}</span>
      </div>

      {sites.length === 0 ? (
        <div className="rail__empty">
          导入数据后
          <br />
          每个 site 生成一张图
        </div>
      ) : sites.length === 1 ? (
        <div className="rail__single">
          <span>{sites[0].siteLabel}</span>
          <span className="mono">{formatCount(sites[0].knownCount)} 点</span>
        </div>
      ) : (
        <ul className="rail__list">
          {sites.map((site) => {
            const rate = site.knownCount > 0 ? site.passCount / site.knownCount : null
            const isActive = site.siteId === activeSiteId
            return (
              <li key={site.siteId}>
                <button
                  type="button"
                  className={`site-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setActiveSite(site.siteId)}
                  aria-pressed={isActive}
                >
                  <span className="site-item__name">{site.siteLabel}</span>
                  <span className="site-item__meta mono">
                    {formatCount(site.knownCount)} 点 · {formatPercent(rate)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="rail__section">
        <div className="rail__label">数据集</div>
        <div className="rail__row">
          <span>文件</span>
          <span className="mono">{fileName ?? '未导入'}</span>
        </div>
        <div className="rail__row">
          <span>类型</span>
          <span className="mono">
            {dataset ? (dataset.kind === '2d' ? '2D Shmoo' : '1D Shmoo') : '—'}
          </span>
        </div>
        <div className="rail__row">
          <span>网格</span>
          <span className="mono">{dataset ? `${nx} × ${ny}` : '—'}</span>
        </div>
        <div className="rail__row">
          <span>值类型</span>
          <span className="mono">
            {dataset ? (dataset.valueType === 'measured' ? 'measured' : 'pass/fail') : '—'}
          </span>
        </div>
      </div>

      <div className="rail__section">
        <div className="rail__label">导入报告</div>
        <div className="rail__row">
          <span>有效点</span>
          <span className="mono">{formatCount(report?.validRows)}</span>
        </div>
        <div className="rail__row">
          <span>跳过行</span>
          <span className="mono">{formatCount(report?.skippedRows)}</span>
        </div>
        <div className="rail__row">
          <span>重复点</span>
          <span className="mono">{formatCount(report?.duplicateRows)}</span>
        </div>
        <div className="rail__row">
          <span>缺失比例</span>
          <span className="mono">{formatPercent(report?.missingRatio)}</span>
        </div>
        <div className="rail__row">
          <span>问题</span>
          <span className="mono">{formatCount(report?.issues.length)}</span>
        </div>
      </div>
    </aside>
  )
}
