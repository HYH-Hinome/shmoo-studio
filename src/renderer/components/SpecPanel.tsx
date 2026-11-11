import { computePassRate } from '@shared/csv/parser'
import { evaluatePoint, isSpecComplete } from '@shared/spec/evaluate'
import { formatPercent, formatSigned } from '../lib/format'
import { useAppStore } from '../state/store'

/**
 * 右侧规格面板。
 * 按决策 D1：spec 全局共用一份，不按 site 区分，所以面板不出现 site 选择。
 * 本阶段展示的都是解析出来的真实 spec 与统计（输入控件仍 disabled，实时编辑在阶段 ⑥ 接入）。
 */
export function SpecPanel(): JSX.Element {
  const spec = useAppStore((s) => s.spec)
  const dataset = useAppStore((s) => s.dataset)

  const passRate = dataset ? computePassRate(dataset) : null
  const specReady = isSpecComplete(spec)

  // 最差 margin：遍历所有已知单元，取最小值（越负越危险）。
  // 数据量最多几千点，单次渲染成本可忽略；等阶段 ⑥ 支持编辑 spec 时再考虑做增量缓存。
  let worstMargin: number | null = null
  if (dataset) {
    for (const site of dataset.sites) {
      for (let i = 0; i < site.value.length; i++) {
        const value = site.value[i]
        if (!Number.isFinite(value)) continue
        const { margin } = evaluatePoint(value, spec)
        if (margin === null) continue
        if (worstMargin === null || margin < worstMargin) worstMargin = margin
      }
    }
  }

  return (
    <aside className="panel" aria-label="规格判定">
      <div className="panel__head">规格判定</div>
      <p className="panel__note">
        全局共用一份 spec，修改后所有 site 同步重算。
        {dataset && !specReady ? ' 当前未配置 spec，所有点位判为未知。' : ''}
      </p>

      <div className="panel__body">
        <label className="field">
          <span className="field__label">判定模式</span>
          <select value={spec.mode} disabled>
            <option value="min">单边 · 下限</option>
            <option value="max">单边 · 上限</option>
            <option value="window">双边 · 窗口</option>
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
            <span className="stat__value">{formatPercent(passRate)}</span>
          </div>
          <div className="stat">
            <span className="stat__label">最差 margin</span>
            <span className="stat__value">
              {formatSigned(worstMargin)}
              {worstMargin !== null && dataset?.valueUnit ? (
                <span className="stat__unit"> {dataset.valueUnit}</span>
              ) : null}
            </span>
          </div>
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
