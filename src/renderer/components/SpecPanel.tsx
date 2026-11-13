import { useCallback, useEffect, useRef, useState } from 'react'
import { computePassRate } from '@shared/csv/parser'
import { isSameSpec } from '@shared/spec/apply'
import { evaluatePoint, isMarginMeaningful, isSpecComplete } from '@shared/spec/evaluate'
import { parseSpecInput, specModeLabel, specValueToText } from '@shared/spec/input'
import type { SpecSide } from '@shared/types/shmoo'
import { formatPercent, formatSigned } from '../lib/format'
import { tickDecimals } from '../chart/geometry'
import { findPassRuns, pickPrimaryRun } from '../chart/oneD'
import { buildSliceSeries, worstPointOfSeries } from '../chart/slice'
import { useAppStore } from '../state/store'

/** 输入停止多久后应用（毫秒）。足够过滤打字中间态，又不会让用户觉得“没反应” */
const APPLY_DEBOUNCE_MS = 250

/**
 * 右侧规格面板。
 * 按决策 D1：spec 全局共用一份，不按 site 区分，所以面板不出现 site 选择。
 *
 * 阶段 ⑥：
 *  - 下限 / 上限可直接编辑，支持只填一边、两边都填、min === max；
 *  - 输入非法（非数字 / 两边都空 / min > max）时显示原因并拒绝应用，
 *    不会静默改成默认值；
 *  - 边调边看：输入停顿 250ms 后自动应用，无需点“应用”按钮；
 *  - 支持「重置为文件值」与一步「撤销上一步」。
 *
 * 阶段 ④ 追加：进入 2D 切片视图后，这里改为显示“这条曲线”的统计
 * （通过率 / 最差 margin / 通过区间），而不是整个数据集的汇总。
 */
export function SpecPanel(): JSX.Element {
  const spec = useAppStore((s) => s.spec)
  const dataset = useAppStore((s) => s.dataset)
  const activeSiteId = useAppStore((s) => s.activeSiteId)
  const slice = useAppStore((s) => s.slice)
  const applySpec = useAppStore((s) => s.applySpec)
  const resetSpec = useAppStore((s) => s.resetSpec)
  const undoSpec = useAppStore((s) => s.undoSpec)
  const fileSpec = useAppStore((s) => s.fileSpec)
  const canUndo = useAppStore((s) => s.specHistory.length > 0)

  const passRate = dataset ? computePassRate(dataset) : null
  const specReady = isSpecComplete(spec)

  // 输入框文本与 store 里的 spec 分离：允许用户输入中间态（如 "74"），
  // 只有通过校验后才写入 store；非法时保留上一次有效结果。
  const [minText, setMinText] = useState(() => specValueToText(spec.min))
  const [maxText, setMaxText] = useState(() => specValueToText(spec.max))
  const [specError, setSpecError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 自己触发的 applySpec 会让 spec 变化，此时不要用规格化后的数字覆盖用户正在输入的文本
  const selfEditRef = useRef(false)
  // blur / Enter 需要立即提交最新的两个输入值
  const latestRef = useRef({ minText, maxText })
  latestRef.current = { minText, maxText }

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 卸载时清理防抖定时器，避免向已卸载组件写状态
  useEffect(() => clearTimer, [clearTimer])

  /**
   * 立即校验并应用。
   * 返回是否成功，供 blur / Enter 复用；失败时只显示错误，不写 store。
   */
  const commit = useCallback(
    (min: string, max: string): boolean => {
      const result = parseSpecInput(min, max)
      if (!result.ok || !result.spec) {
        setSpecError(result.error ?? '输入无效')
        return false
      }
      setSpecError(null)
      const nextSpec =
        typeof spec.target === 'number' ? { ...result.spec, target: spec.target } : result.spec
      // 文本格式变化但语义相同（如 "740" ↔ "740.0"）时不必写 store / 记历史
      if (!isSameSpec(nextSpec, spec)) {
        selfEditRef.current = true
        applySpec(nextSpec)
      }
      return true
    },
    [applySpec, spec]
  )

  // 外部变化（重置 / 撤销 / 导入新文件）时把输入框同步成 store 里的值。
  // 自己编辑导致的 spec 变化跳过一次，避免打断正在输入的小数点。
  useEffect(() => {
    if (selfEditRef.current) {
      selfEditRef.current = false
      return
    }
    setMinText(specValueToText(spec.min))
    setMaxText(specValueToText(spec.max))
    setSpecError(null)
  }, [spec.min, spec.max, spec.mode, dataset?.id])

  /** 输入变化：先即时校验提示，合法则防抖应用 */
  const handleChange = (which: 'min' | 'max', value: string) => {
    const nextMin = which === 'min' ? value : minText
    const nextMax = which === 'max' ? value : maxText
    if (which === 'min') setMinText(value)
    else setMaxText(value)
    latestRef.current = { minText: nextMin, maxText: nextMax }

    clearTimer()
    const result = parseSpecInput(nextMin, nextMax)
    if (!result.ok) {
      setSpecError(result.error ?? '输入无效')
      return
    }
    setSpecError(null)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      commit(nextMin, nextMax)
    }, APPLY_DEBOUNCE_MS)
  }

  const flush = () => {
    clearTimer()
    commit(latestRef.current.minText, latestRef.current.maxText)
  }

  const handleReset = () => {
    clearTimer()
    setSpecError(null)
    if (fileSpec) {
      // 文本立即回到文件值；resetSpec 若与当前相同则不会触发 spec 变化
      setMinText(specValueToText(fileSpec.min))
      setMaxText(specValueToText(fileSpec.max))
    }
    selfEditRef.current = false
    resetSpec()
  }

  const handleUndo = () => {
    clearTimer()
    setSpecError(null)
    selfEditRef.current = false
    undoSpec()
    // 撤销后主动同步文本：即使 spec 变化没触发 effect（极端情况），输入框也不会残留非法值
    const restored = useAppStore.getState().spec
    setMinText(specValueToText(restored.min))
    setMaxText(specValueToText(restored.max))
  }

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
  const resetDisabled = !fileSpec || isSameSpec(spec, fileSpec)

  return (
    <aside className="panel" aria-label="规格判定">
      <div className="panel__head">规格判定</div>
      <p className="panel__note">
        {sliceStats ? '当前显示切片曲线的最差 margin 与通过区间。' : '全局共用一份 spec，修改后所有 site 同步重算。'}
        {dataset && !specReady ? ' 当前未配置 spec，所有点位判为未知。' : ''}
        {dataset && !marginUsable && specReady
          ? ' 当前数据为二值/零宽窗口，margin 无连续量意义，显示为不适用。'
          : ''}
        {dataset?.passSource === 'file'
          ? ' 当前按 CSV pass 列判定：有 pass 值的格子不随 spec 改变颜色。'
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
          <span className="field__hint">{specModeLabel(spec)} · 输入后自动应用</span>
        </label>

        <label className="field">
          <span className="field__label">下限 min（留空表示不设）</span>
          <input
            className={`mono${specError ? ' is-invalid' : ''}`}
            data-spec-min="1"
            value={minText}
            inputMode="decimal"
            aria-invalid={specError ? true : undefined}
            placeholder="例如 720"
            onChange={(e) => handleChange('min', e.target.value)}
            onBlur={flush}
            onKeyDown={(e) => {
              if (e.key === 'Enter') flush()
            }}
          />
        </label>

        <label className="field">
          <span className="field__label">上限 max（留空表示不设）</span>
          <input
            className={`mono${specError ? ' is-invalid' : ''}`}
            data-spec-max="1"
            value={maxText}
            inputMode="decimal"
            aria-invalid={specError ? true : undefined}
            placeholder="例如 860"
            onChange={(e) => handleChange('max', e.target.value)}
            onBlur={flush}
            onKeyDown={(e) => {
              if (e.key === 'Enter') flush()
            }}
          />
        </label>

        {specError ? (
          <p className="panel__error" role="alert" data-spec-error="1">
            {specError} · 已保留上一次有效结果
          </p>
        ) : null}

        <div className="panel__actions">
          <button
            type="button"
            className="btn"
            data-spec-undo="1"
            disabled={!canUndo}
            onClick={handleUndo}
          >
            撤销上一步
          </button>
          <button
            type="button"
            className="btn"
            data-spec-reset="1"
            disabled={resetDisabled}
            onClick={handleReset}
          >
            重置为文件值
          </button>
        </div>

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
