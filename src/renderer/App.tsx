import { useEffect } from 'react'
import { ChartStage } from './components/ChartStage'
import { SiteRail } from './components/SiteRail'
import { SpecPanel } from './components/SpecPanel'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { useAppStore } from './state/store'

/**
 * 应用外壳：
 *   标题栏（自绘）
 *   ├─ 左：站点栏
 *   ├─ 中：图表区（阶段 ① 为占位）
 *   └─ 右：规格面板
 *   状态栏
 * 阶段 ① 的目标是“链路通”：窗口能起、IPC 能读文件、热更新生效。
 */
export default function App(): JSX.Element {
  const openCsv = useAppStore((s) => s.openCsv)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)

  // 启动时读取版本信息（一次性）
  useEffect(() => {
    void loadAppInfo()
  }, [loadAppInfo])

  // 订阅主进程菜单命令：菜单与界面按钮共用同一套动作
  useEffect(() => {
    // 纯浏览器中预览（没有 preload）时 window.shmoo 不存在，直接跳过，
    // 这样视觉验证/截图可以在普通浏览器里跑，不影响 Electron 内行为
    if (typeof window.shmoo === 'undefined') return
    const unsubscribe = window.shmoo.onCommand((command) => {
      if (command === 'open-csv') void openCsv()
    })
    return unsubscribe
  }, [openCsv])

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <SiteRail />
        <ChartStage />
        <SpecPanel />
      </div>
      <StatusBar />
    </div>
  )
}
