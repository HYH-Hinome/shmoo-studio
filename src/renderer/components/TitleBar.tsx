/**
 * 自绘标题栏。
 * 窗口本身使用 titleBarStyle: 'hidden' + titleBarOverlay，
 * 因此这里只画左侧品牌区，右侧 148px 留给原生窗口按钮（CSS padding 预留）。
 * 整条标题栏是拖拽区域，内部可交互元素需显式 no-drag。
 */
export function TitleBar(): JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        {/* 品牌标记：四个小方块象征 shmoo 网格，纯 CSS 绘制 */}
        <span className="titlebar__mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="titlebar__name">SHMOO STUDIO</span>
        <span className="titlebar__divider" aria-hidden="true" />
        <span className="titlebar__sub">ATE Shmoo Analyzer</span>
      </div>

      <div className="titlebar__right">
        <span className="titlebar__hint">Ctrl+O 打开 CSV</span>
        <span className="chip">
          <span className="chip__dot" aria-hidden="true" />
          离线
        </span>
      </div>
    </header>
  )
}
