import { computePassRate } from '@shared/csv/parser'
import { evaluatePoint, isMarginMeaningful, isSpecComplete } from '@shared/spec/evaluate'
import type { SpecSide } from '@shared/types/shmoo'
import { formatPercent, formatSigned } from '../lib/format'
import { tickDecimals } from '../chart/geometry'
import { findPassRuns, pickPrimaryRun } from '../chart/oneD'
import { buildSliceSeries, worstPointOfSeries } from '../chart/slice'
import { useAppStore } from '../state/store'

/**
 * 右侧规格面板。
 * 按决策 D1：spec 全局共用一份，不按 site 区分，所以面板不出现 site 选择。
 * 本阶段展示的都是解析出来的真实 spec 与统计（输入控件仍 disabled，实时编辑在阶段 ⑥ 接入）。
 *
 * 阶段 ④ 追加：进入 2D 切片视图后，这里改为显示“这条曲线”的统计
 * （通过率 / 最差 margin / 通过区间），而不是整个数据集的汇总。
 */
export function SpecPanel(): JSX.Element {
  const spec = useAppStore((s) => s.spec)
  const dataset = useAppStore((s) => s.dataset)
  const activeSiteId = useAppStore((s) => s.activeSiteId)
  const slice = useAppStore((s) => s.slice)

  const passRate = dataset ? computePassRate(dataset) : null
  const specReady = isSpecComplete(spec)

  // 切片统计：只有 2D 数据集 + 当前站点 + 激活的切片三者齐备时才成立
  const sliceSeries = (() => {
    if (!dataset || dataset.kind !== '2d' || !slice) return null
    const site = dataset.sites.find((item) => item.siteId === activeSiteId)
    if (!site) return null
    return buildSliceSeries(dataset, site, slice)
  })()

  const sliceStats = (() => {
    if (!sliceSeries) return null
    let known = 0
    let pass = 0
    for (let i = 0; i < sliceSeries.value.length; i++) {
      if (!Number.isFinite(sliceSeries.value[i])) continue
      known += 1
      if (sliceSeries.pass[i] === 1) pass += 1
    }
    const primary = pickPrimaryRun(findPassRuns(sliceSeries.axis.values, sliceSeries.pass))
    const decimals = tickDecimals(sliceSeries.axis.values)
    const unit = sliceSeries.axis.unit ? ` ${sliceSeries.axis.unit}` : ''
    const worst = worstPointOfSeries(sliceSeries, spec)
    return {
      passRate: known > 0 ? pass / known : null,
      worstMargin: worst?.margin ?? null,
      worstSide: worst?.side ?? null,
      window: primary
        ? `${primary.startX.toFixed(decimals)} – ${primary.endX.toFixed(decimals)}${unit}`
        : '无连续 PASS 区间'
    }
  })()

  // 最差 margin：遍历所有已知单元，取最小值（越负越危险），并记住它撞到哪一边。
  // 数据量最多几千点，单次渲染成本可忽略；等阶段 ⑥ 支持编辑 spec 时再考虑做增量缓存。
  let worstMargin: number | null = null
  let worstSide: SpecSide | null = null
  if (dataset && !sliceStats) {
    for (const site of dataset.sites) {
      for (let i = 0; i < site.value.length; i++) {
        const value = site.value[i]
        if (!Number.isFinite(value)) continue
        const { margin, side } = evaluatePoint(value, spec)
        if (margin === null) continue
        if (worstMargin === null || margin < worstMargin) {
          worstMargin = margin
          worstSide = side
        }
      }
    }
  }

  // 二值 / 零宽窗口数据：margin 没有连续量意义，直接显示“不适用”
  const marginUsable = dataset ? isMarginMeaningful(dataset) : false
  const shownMargin = sliceStats ? sliceStats.worstMargin : worstMargin
  const shownSide = sliceStats ? sliceStats.worstSide : worstSide

  return (
    <aside className="panel" aria-label="规格判定">
      <div className="panel__head">规格判定</div>
      <p className="panel__note">
        {sliceStats ? '当前显示切片曲线的最差 margin 与通过区间。' : '全局共用一份 spec，修改后所有 site 同步重算。'}
        {dataset && !specReady ? ' 当前未配置 spec，所有点位判为未知。' : ''}
        {dataset && !marginUsable && specReady
          ? ' 当前数据为二值/零宽窗口，margin 无连续量意义，显示为不适用。'
          : ''}
      </p>

      <div className="panel__body">
        <label className="field">
          <span className="field__label">判定模式</span>
          <select value={spec.mode} disabled>
            <option value="min">单边 · 下限</option>
            <option value="max">单边 · 上限</option>
            <option value="window">双边 · 窗口</option>
            <option value="none">无 spec · 不比较</option>
          </select>
        </label>

        <label className="field">
          <span className="field__label">下限 min</span>
          <input className="mono" value={spec.min ?? '—'} disabled readOnly />
        </label>

        <label className="field">
          <span className="field__label">上限 max</span>
          <input className="mono" value={spec.max ?? '—'} disabled readOnly />
        </label>

        <div className="panel__divider" />

        <div className="panel__stats">
          <div className="stat">
            <span className="stat__label">通过率</span>
            <span className="stat__value">
              {formatPercent(sliceStats ? sliceStats.passRate : passRate)}
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">最差 margin</span>
            <span className="stat__value">
              {marginUsable ? (
                <>
                  {formatSigned(shownMargin)}
                  {dataset?.valueUnit ? (
                    <span className="stat__unit"> {dataset.valueUnit}</span>
                  ) : null}
                  {/* 双边 spec 下标明最差点撞的是上限还是下限；单边时恒为同一侧，不重复 */}
                  {shownSide && spec.mode === 'window' ? (
                    <span className="stat__unit">
                      （{shownSide === 'max' ? '上限' : '下限'}）
                    </span>
                  ) : null}
                </>
              ) : (
                '不适用'
              )}
            </span>
          </div>
          {sliceStats ? (
            <div className="stat stat--wide">
              <span className="stat__label">通过区间</span>
              <span className="stat__value">{sliceStats.window}</span>
            </div>
          ) : null}
        </div>

        <label className="field">
          <span className="field__label">判定来源</span>
          <select value={dataset?.passSource ?? 'derived'} disabled>
            <option value="derived">由 spec 推导</option>
            <option value="file">按 CSV pass 列</option>
          </select>
        </label>
      </div>
    </aside>
  )
}
