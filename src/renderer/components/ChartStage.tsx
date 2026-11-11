import { useAppStore } from '../state/store'

/**
 * 中央图表区。
 * 阶段 ① 只做占位：网格底纹 + 扫描线 + 四角标记 + 空态引导。
 * 真实的 Canvas 渲染在阶段 ③（2D）与阶段 ④（1D）接入，
 * 届时该组件会替换 .stage__canvas 内部的占位内容。
 */
export function ChartStage(): JSX.Element {
  const openCsv = useAppStore((s) => s.openCsv)
  const dataset = useAppStore((s) => s.dataset)

  return (
    <main className="stage">
      <div className="stage__toolbar">
        <div className="segmented" role="group" aria-label="图表类型">
          <button type="button" className="is-active" disabled>
            2D Shmoo
          </button>
          <button type="button" disabled>
            1D Shmoo
          </button>
        </div>
        <div className="stage__spacer" />
        <span className="stage__badge">{dataset ? '已载入' : '未载入数据'}</span>
      </div>

      <div className="stage__canvas">
        <div className="stage__scan" aria-hidden="true" />
        <span className="stage__corner stage__corner--tl" aria-hidden="true" />
        <span className="stage__corner stage__corner--tr" aria-hidden="true" />
        <span className="stage__corner stage__corner--bl" aria-hidden="true" />
        <span className="stage__corner stage__corner--br" aria-hidden="true" />

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
      </div>
    </main>
  )
}
