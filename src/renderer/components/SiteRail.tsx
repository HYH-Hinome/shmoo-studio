import { useAppStore } from '../state/store'

/**
 * 左侧站点栏。
 * 按决策 D2：一个 site 一张图，站点数量由数据决定；
 * 阶段 ① 无数据，所以只展示空态与数据集信息占位。
 */
export function SiteRail(): JSX.Element {
  const dataset = useAppStore((s) => s.dataset)
  const fileName = useAppStore((s) => s.fileName)
  const sites = dataset?.sites ?? []

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
      ) : (
        <ul>{/* 阶段 ③ 接入真实的站点切换列表 */}</ul>
      )}

      <div className="rail__section">
        <div className="rail__label">数据集</div>
        <div className="rail__row">
          <span>文件</span>
          <span className="mono">{fileName ?? '未导入'}</span>
        </div>
        <div className="rail__row">
          <span>类型</span>
          <span className="mono">{dataset ? (dataset.kind === '2d' ? '2D' : '1D') : '—'}</span>
        </div>
        <div className="rail__row">
          <span>网格</span>
          <span className="mono">—</span>
        </div>
      </div>

      <div className="rail__section">
        <div className="rail__label">导入报告</div>
        <div className="rail__row">
          <span>有效点</span>
          <span className="mono">—</span>
        </div>
        <div className="rail__row">
          <span>跳过行</span>
          <span className="mono">—</span>
        </div>
        <div className="rail__row">
          <span>缺失单元</span>
          <span className="mono">—</span>
        </div>
      </div>
    </aside>
  )
}
