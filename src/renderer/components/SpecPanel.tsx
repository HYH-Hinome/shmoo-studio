import { useAppStore } from '../state/store'

/**
 * 右侧规格面板。
 * 按决策 D1：spec 全局共用一份，不按 site 区分，所以面板不出现 site 选择。
 * 阶段 ① 输入控件为占位（disabled），阶段 ⑥ 接入实时重算。
 */
export function SpecPanel(): JSX.Element {
  const spec = useAppStore((s) => s.spec)
  const dataset = useAppStore((s) => s.dataset)

  return (
    <aside className="panel" aria-label="规格判定">
      <div className="panel__head">规格判定</div>
      <p className="panel__note">全局共用一份 spec，修改后所有 site 同步重算。</p>

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
            <span className="stat__value">—</span>
          </div>
          <div className="stat">
            <span className="stat__label">最差 margin</span>
            <span className="stat__value">—</span>
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
