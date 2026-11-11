import { formatCount } from '../lib/format'
import { useAppStore } from '../state/store'
import { Shmoo2DChart } from './Shmoo2DChart'

/**
 * 中央图表区。
 *  - 2D 数据集：阶段 ③ 起接入真实 Canvas 渲染（三层画布，见 Shmoo2DChart）；
 *  - 1D 数据集：仍为信息卡占位，折线图在阶段 ④ 接入；
 *  - 未导入：空态引导。
 */
export function ChartStage(): JSX.Element {
  const openCsv = useAppStore((s) => s.openCsv)
  const dataset = useAppStore((s) => s.dataset)
  const activeSiteId = useAppStore((s) => s.activeSiteId)
  const report = useAppStore((s) => s.report)
  const colorMode = useAppStore((s) => s.colorMode)
  const setColorMode = useAppStore((s) => s.setColorMode)

  const activeSite = dataset?.sites.find((site) => site.siteId === activeSiteId) ?? null
  const nx = dataset?.xAxis.values.length ?? 0
  const ny = dataset?.yAxis?.values.length ?? (dataset ? 1 : 0)
  // 2D 数据集必须同时具备 y 轴与当前站点，才进入真实渲染分支
  const render2D = dataset?.kind === '2d' && !!dataset.yAxis && !!activeSite

  // spec 描述文案：未配置时明确提示，而不是显示一个空白的输入框
  const specText = (() => {
    if (!dataset) return '—'
    const unit = dataset.valueUnit
    const { mode, min, max } = dataset.spec
    if (mode === 'window' && typeof min === 'number' && typeof max === 'number') {
      return `${min} ≤ ${dataset.valueLabel} ≤ ${max} ${unit}`.trim()
    }
    if (mode === 'min' && typeof min === 'number') {
      return `${dataset.valueLabel} ≥ ${min} ${unit}`.trim()
    }
    if (mode === 'max' && typeof max === 'number') {
      return `${dataset.valueLabel} ≤ ${max} ${unit}`.trim()
    }
    return '未配置 spec（所有点位将判为未知）'
  })()

  return (
    <main className="stage">
      <div className="stage__toolbar">
        <div className="segmented" role="group" aria-label="图表类型">
          <button
            type="button"
            className={dataset?.kind === '2d' ? 'is-active' : undefined}
            disabled
          >
            2D Shmoo
          </button>
          <button
            type="button"
            className={dataset?.kind === '1d' ? 'is-active' : undefined}
            disabled
          >
            1D Shmoo
          </button>
        </div>

        {/* 配色模式仅对 2D 有意义；1D 折线图在阶段 ④ 接入后再决定是否复用 */}
        <div className="segmented" role="group" aria-label="配色模式">
          <button
            type="button"
            className={colorMode === 'binary' ? 'is-active' : undefined}
            disabled={!render2D}
            onClick={() => setColorMode('binary')}
          >
            二值
          </button>
          <button
            type="button"
            className={colorMode === 'heat' ? 'is-active' : undefined}
            disabled={!render2D}
            onClick={() => setColorMode('heat')}
          >
            热力
          </button>
        </div>

        <div className="stage__spacer" />
        {activeSite ? <span className="stage__badge">{activeSite.siteLabel}</span> : null}
        <span className="stage__badge">
          {dataset ? `网格 ${nx} × ${ny}` : '未载入数据'}
        </span>
        {report && report.issues.length > 0 ? (
          <span className="stage__badge stage__badge--warn">
            {formatCount(report.issues.length)} 条导入提示
          </span>
        ) : null}
      </div>

      <div className={`stage__canvas${render2D ? ' stage__canvas--chart' : ''}`}>
        <div className="stage__scan" aria-hidden="true" />
        <span className="stage__corner stage__corner--tl" aria-hidden="true" />
        <span className="stage__corner stage__corner--tr" aria-hidden="true" />
        <span className="stage__corner stage__corner--bl" aria-hidden="true" />
        <span className="stage__corner stage__corner--br" aria-hidden="true" />

        {dataset && render2D && activeSite && dataset.yAxis ? (
          <div className="stage__chartview">
            <header className="chart-head">
              <div className="chart-head__main">
                <p className="chart-head__eyebrow">
                  2D SHMOO · {nx} × {ny}
                </p>
                <h1 className="chart-head__title">{dataset.title}</h1>
                <p className="chart-head__axes">
                  {dataset.xAxis.label}
                  {dataset.xAxis.unit ? ` (${dataset.xAxis.unit})` : ''}
                  {' × '}
                  {dataset.yAxis.label}
                  {dataset.yAxis.unit ? ` (${dataset.yAxis.unit})` : ''}
                  {' · 值 '}
                  {dataset.valueLabel}
                  {dataset.valueUnit ? ` (${dataset.valueUnit})` : ''}
                </p>
              </div>
              <dl className="chart-head__facts">
                <div>
                  <dt>当前站点</dt>
                  <dd className="mono">{activeSite.siteLabel}</dd>
                </div>
                <div>
                  <dt>有效点</dt>
                  <dd className="mono">
                    {formatCount(activeSite.knownCount)} / {formatCount(nx * ny)}
                  </dd>
                </div>
                <div>
                  <dt>规格</dt>
                  <dd className="mono">{specText}</dd>
                </div>
                <div>
                  <dt>判定来源</dt>
                  <dd className="mono">
                    {dataset.passSource === 'file' ? 'CSV pass 列' : 'spec 推导'}
                  </dd>
                </div>
              </dl>
            </header>

            <Shmoo2DChart
              dataset={dataset}
              site={activeSite}
              xAxis={dataset.xAxis}
              yAxis={dataset.yAxis}
              mode={colorMode}
            />
          </div>
        ) : dataset ? (
          <div className="stage__info">
            <p className="stage__eyebrow">
              {dataset.kind === '2d' ? '2D SHMOO' : '1D SHMOO'} · {nx} × {ny}
            </p>
            <h1 className="stage__title">{dataset.title}</h1>
            <p className="stage__desc">
              {dataset.xAxis.label}
              {dataset.xAxis.unit ? ` (${dataset.xAxis.unit})` : ''}
              {dataset.yAxis
                ? ` × ${dataset.yAxis.label}${dataset.yAxis.unit ? ` (${dataset.yAxis.unit})` : ''}`
                : ''}
              {' · '}
              值 {dataset.valueLabel}
              {dataset.valueUnit ? ` (${dataset.valueUnit})` : ''}
            </p>

            <dl className="stage__facts">
              <div>
                <dt>当前站点</dt>
                <dd className="mono">{activeSite?.siteLabel ?? '—'}</dd>
              </div>
              <div>
                <dt>该站点有效点</dt>
                <dd className="mono">{formatCount(activeSite?.knownCount)}</dd>
              </div>
              <div>
                <dt>规格</dt>
                <dd className="mono">{specText}</dd>
              </div>
              <div>
                <dt>判定来源</dt>
                <dd className="mono">
                  {dataset.passSource === 'file' ? 'CSV pass 列' : 'spec 推导'}
                </dd>
              </div>
            </dl>

            <p className="stage__hint">1D 折线图将在阶段 ④ 接入，本阶段只展示数据链路。</p>
          </div>
        ) : (
          <div className="stage__empty">
            <p className="stage__eyebrow">NO DATASET</p>
            <h1 className="stage__title">导入 CSV 开始分析</h1>
            <p className="stage__desc">
              支持自定义长表格式（<code>#</code> 元数据头），自动识别 2D / 1D Shmoo 与站点数量
            </p>
            <button type="button" className="btn btn--primary" onClick={() => void openCsv()}>
              打开 CSV
            </button>
            <p className="stage__hint">或直接将文件拖入此区域</p>
          </div>
        )}
      </div>
    </main>
  )
}
