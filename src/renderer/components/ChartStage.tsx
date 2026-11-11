import { formatCount, formatSigned } from '../lib/format'
import { useAppStore } from '../state/store'
import { tickDecimals } from '../chart/geometry'
import { findPassRuns, pickPrimaryRun } from '../chart/oneD'
import { buildSliceDataset, worstPointOfSeries } from '../chart/slice'
import { isHeatMeaningful, isMarginMeaningful, isZeroWidthWindow } from '@shared/spec/evaluate'
import { Shmoo1DChart } from './Shmoo1DChart'
import { Shmoo2DChart } from './Shmoo2DChart'

/**
 * 中央图表区。
 *  - 2D 数据集：三层画布渲染色块地图（阶段 ③）；
 *  - 1D 数据集：二值色带 / 连续曲线两种形态（阶段 ④）；
 *  - 未导入：空态引导。
 *
 * 两种视图共用同一套 `.stage__chartview` 骨架、图表头部高度与画布容器，
 * 因此切换数据集或 1D 形态时不会出现布局跳动。
 */
export function ChartStage(): JSX.Element {
  const openCsv = useAppStore((s) => s.openCsv)
  const dataset = useAppStore((s) => s.dataset)
  const activeSiteId = useAppStore((s) => s.activeSiteId)
  const report = useAppStore((s) => s.report)
  const colorMode = useAppStore((s) => s.colorMode)
  const setColorMode = useAppStore((s) => s.setColorMode)
  const oneDForm = useAppStore((s) => s.oneDForm)
  const setOneDForm = useAppStore((s) => s.setOneDForm)
  const slice = useAppStore((s) => s.slice)
  const sliceMarker = useAppStore((s) => s.sliceMarker)
  const openSlice = useAppStore((s) => s.openSlice)
  const setSliceAxis = useAppStore((s) => s.setSliceAxis)
  const closeSlice = useAppStore((s) => s.closeSlice)

  const activeSite = dataset?.sites.find((site) => site.siteId === activeSiteId) ?? null
  const nx = dataset?.xAxis.values.length ?? 0
  const ny = dataset?.yAxis?.values.length ?? (dataset ? 1 : 0)
  // 2D 数据集必须同时具备 y 轴与当前站点，才进入真实渲染分支
  const render2D = dataset?.kind === '2d' && !!dataset.yAxis && !!activeSite
  // 1D 数据集：一条扫描轴 + 一个站点（一个 site 一张图，D2）
  const render1D = dataset?.kind === '1d' && !!activeSite

  /**
   * 2D → 1D 切片（阶段 ④ 追加）。
   * 切片结果被包装成一份普通的 1D 数据集，交给同一个 Shmoo1DChart，
   * 因此不会有第二套画法与第二套判定规则。
   */
  const sliceView =
    dataset && dataset.kind === '2d' && dataset.yAxis && activeSite && slice
      ? buildSliceDataset(dataset, activeSite, slice)
      : null

  // 真正交给 1D 渲染器的数据：切片优先，其次是原生 1D 数据集
  const oneDHost = sliceView ?? (dataset && render1D && activeSite ? { dataset, site: activeSite } : null)
  const chartDataset = oneDHost?.dataset ?? null
  const chartSite = oneDHost?.site ?? null
  const chartPointCount = chartDataset?.xAxis.values.length ?? 0

  // 1D 二值色带的通过窗口摘要：报告“最长连续 PASS 区间”的边界与宽度
  const windowSummary = (() => {
    if (!oneDHost) return '—'
    const runs = findPassRuns(oneDHost.dataset.xAxis.values, oneDHost.site.pass)
    const primary = pickPrimaryRun(runs)
    if (!primary) return '无连续 PASS 区间'
    const decimals = tickDecimals(oneDHost.dataset.xAxis.values)
    const unit = oneDHost.dataset.xAxis.unit ? ` ${oneDHost.dataset.xAxis.unit}` : ''
    const extra = runs.length > 1 ? ` · 另有 ${runs.length - 1} 段` : ''
    return `${primary.startX.toFixed(decimals)} – ${primary.endX.toFixed(decimals)}${unit} · 宽 ${primary.width.toFixed(decimals)}${unit}${extra}`
  })()

  // 切片视图要显示“这条曲线自己”的最差 margin（含撞哪一边），而不是整个数据集的统计
  const sliceWorst = (() => {
    if (!sliceView || !dataset) return null
    return worstPointOfSeries(sliceView.series, dataset.spec)
  })()

  // margin 是否有物理意义：二值/零宽窗口数据只显示“不适用”，不输出假数字
  const marginUsable = dataset ? isMarginMeaningful(dataset) : false
  const heatUsable = dataset ? isHeatMeaningful(dataset) : false
  // 二值数据没有连续量：即使 store 里记着 heat，也按二值渲染，避免出现无意义的色块
  const effectiveColorMode = heatUsable ? colorMode : 'binary'

  // spec 描述文案：未配置时明确提示，而不是显示一个空白的输入框
  const specText = (() => {
    if (!dataset) return '—'
    const unit = dataset.valueUnit
    const { mode, min, max } = dataset.spec
    if (isZeroWidthWindow(dataset.spec)) {
      return `${dataset.valueLabel} = ${min} ${unit}`.trim()
    }
    if (mode === 'window' && typeof min === 'number' && typeof max === 'number') {
      return `${min} ≤ ${dataset.valueLabel} ≤ ${max} ${unit}`.trim()
    }
    if (mode === 'min' && typeof min === 'number') {
      return `${dataset.valueLabel} ≥ ${min} ${unit}`.trim()
    }
    if (mode === 'max' && typeof max === 'number') {
      return `${dataset.valueLabel} ≤ ${max} ${unit}`.trim()
    }
    if (mode === 'none') return 'spec: none（不参与比较）'
    return '未配置 spec（所有点位将判为未知）'
  })()

  /** 最差 margin 的文案：不可用时明确写“不适用”，可用时带上撞边方向 */
  const worstMarginText = (() => {
    if (!marginUsable) return '不适用'
    if (!sliceWorst) return '—'
    const side = sliceWorst.side === 'max' ? '上限' : sliceWorst.side === 'min' ? '下限' : ''
    const unit = chartDataset?.valueUnit ? ` ${chartDataset.valueUnit}` : ''
    return `${formatSigned(sliceWorst.margin)}${unit}${side ? `（${side}）` : ''}`
  })()

  return (
    <main className="stage">
      <div className="stage__toolbar">
        {sliceView ? (
          /* 切片视图：面包屑占据第一组的位置，高度与分段控件一致，切换时不会顶动图表 */
          <nav className="crumb" aria-label="切片路径">
            <button type="button" className="crumb__link" onClick={closeSlice}>
              2D
            </button>
            <span className="crumb__sep" aria-hidden="true">
              ›
            </span>
            <span className="crumb__item mono">{sliceView.series.fixedLabel}</span>
            <span className="crumb__sep" aria-hidden="true">
              ›
            </span>
            <span className="crumb__current">1D 曲线</span>
          </nav>
        ) : (
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
        )}

        {/* 第二组开关随视图变化：切片选行/列方向，2D 选配色，普通 1D 选形态 */}
        <div
          className="segmented"
          role="group"
          aria-label={sliceView ? '切片方向' : render1D ? '1D 图表形态' : '配色模式'}
        >
          {sliceView && slice ? (
            <>
              <button
                type="button"
                className={slice.axis === 'row' ? 'is-active' : undefined}
                onClick={() => setSliceAxis('row')}
              >
                行方向
              </button>
              <button
                type="button"
                className={slice.axis === 'col' ? 'is-active' : undefined}
                onClick={() => setSliceAxis('col')}
              >
                列方向
              </button>
            </>
          ) : render1D ? (
            <>
              <button
                type="button"
                className={oneDForm === 'band' ? 'is-active' : undefined}
                onClick={() => setOneDForm('band')}
              >
                色带
              </button>
              <button
                type="button"
                className={oneDForm === 'curve' ? 'is-active' : undefined}
                onClick={() => setOneDForm('curve')}
              >
                曲线
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={effectiveColorMode === 'binary' ? 'is-active' : undefined}
                disabled={!render2D}
                onClick={() => setColorMode('binary')}
              >
                二值
              </button>
              <button
                type="button"
                className={effectiveColorMode === 'heat' ? 'is-active' : undefined}
                // 只有 0/1 两种取值时热力没有连续量可映射 → 置灰并给出原因
                disabled={!render2D || !heatUsable}
                title={heatUsable ? undefined : '二值数据，无连续量'}
                onClick={() => setColorMode('heat')}
              >
                热力
              </button>
            </>
          )}
        </div>
        <div className="stage__spacer" />
        {activeSite ? <span className="stage__badge">{activeSite.siteLabel}</span> : null}
        <span className="stage__badge">
          {sliceView
            ? `切片 · 扫描点 ${chartPointCount}`
            : dataset
              ? dataset.kind === '1d'
                ? `扫描点 ${nx}`
                : `网格 ${nx} × ${ny}`
              : '未载入数据'}
        </span>
        {report && report.issues.length > 0 ? (
          <span className="stage__badge stage__badge--warn">
            {formatCount(report.issues.length)} 条导入提示
          </span>
        ) : null}
      </div>

      <div className={`stage__canvas${render2D || render1D ? ' stage__canvas--chart' : ''}`}>
        <div className="stage__scan" aria-hidden="true" />
        <span className="stage__corner stage__corner--tl" aria-hidden="true" />
        <span className="stage__corner stage__corner--tr" aria-hidden="true" />
        <span className="stage__corner stage__corner--bl" aria-hidden="true" />
        <span className="stage__corner stage__corner--br" aria-hidden="true" />

        {dataset && render2D && !sliceView && dataset.yAxis ? (
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
                    {dataset.passSource === 'file'
                      ? 'CSV pass 列'
                      : dataset.spec.mode === 'none'
                        ? 'spec: none'
                        : 'spec 推导'}
                  </dd>
                </div>
              </dl>
            </header>

            <Shmoo2DChart
              dataset={dataset}
              site={activeSite}
              xAxis={dataset.xAxis}
              yAxis={dataset.yAxis}
              mode={effectiveColorMode}
              sliceMarker={sliceMarker}
              onSlice={openSlice}
            />
          </div>
        ) : oneDHost && chartDataset && chartSite ? (
          <div className="stage__chartview">
            <header className="chart-head">
              <div className="chart-head__main">
                <p className="chart-head__eyebrow">
                  {sliceView
                    ? `1D 切片 · ${chartPointCount} 采样点 · 连续曲线`
                    : `1D SHMOO · ${chartPointCount} 采样点 · ${oneDForm === 'band' ? '二值色带' : '连续曲线'}`}
                </p>
                <h1 className="chart-head__title">{dataset?.title ?? chartDataset.title}</h1>
                <p className="chart-head__axes">
                  {chartDataset.xAxis.label}
                  {chartDataset.xAxis.unit ? ` (${chartDataset.xAxis.unit})` : ''}
                  {' · 值 '}
                  {chartDataset.valueLabel}
                  {chartDataset.valueUnit ? ` (${chartDataset.valueUnit})` : ''}
                </p>
              </div>
              <dl className="chart-head__facts">
                <div>
                  <dt>当前站点</dt>
                  <dd className="mono">{chartSite.siteLabel}</dd>
                </div>
                <div>
                  <dt>有效点</dt>
                  <dd className="mono">
                    {formatCount(chartSite.knownCount)} / {formatCount(chartPointCount)}
                  </dd>
                </div>
                <div>
                  <dt>通过区间</dt>
                  <dd className="mono">{windowSummary}</dd>
                </div>
                <div>
                  <dt>{sliceView ? '最差 margin' : '规格'}</dt>
                  <dd className="mono">{sliceView ? worstMarginText : specText}</dd>
                </div>
              </dl>
            </header>

            <Shmoo1DChart
              dataset={chartDataset}
              site={chartSite}
              form={sliceView ? 'curve' : oneDForm}
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

            <p className="stage__hint">
              当前数据集没有可用站点，无法绘制图表。请检查 CSV 的 site 列。
            </p>
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
