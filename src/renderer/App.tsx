import { useEffect, useState } from 'react'
import { ChartStage } from './components/ChartStage'
import { ExportDialog } from './components/ExportDialog'
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
  const openDroppedFiles = useAppStore((s) => s.openDroppedFiles)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const openExportDialog = useAppStore((s) => s.openExportDialog)

  // 拖拽进入时显示高亮遮罩；离开或放下后自动恢复
  const [dragActive, setDragActive] = useState(false)

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
      // 导出命令只打开对话框；真正的文件选择与写盘在 ExportDialog 里完成
      if (command === 'export-png') openExportDialog('png')
      if (command === 'export-pdf') openExportDialog('pdf')
    })
    return unsubscribe
  }, [openCsv, openExportDialog])

  // 拖放导入：把从系统里拖进窗口的文件交给 store 的统一载入流程。
  //
  // 关键点：
  //  1. 必须在 dragover / drop 上 preventDefault。否则 Chromium（Electron）会把
  //     被拖入的文件当成导航目标，窗口会直接跳到 file:// 内容页，界面“消失”；
  //  2. 事件监听挂在 window 上并用捕获阶段，这样无论拖到图表、站点栏还是空白处都能接住；
  //  3. dragenter / dragleave 会随子元素冒泡反复触发，用深度计数避免高亮闪烁。
  useEffect(() => {
    let depth = 0

    // 只关心“拖的是文件”的拖拽；拖动文字/链接时不抢默认行为
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragActive(true)
    }

    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      // 阻止默认行为 = 阻止 Electron 导航到被拖入的文件
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragActive(false)
    }

    const onDrop = (event: DragEvent): void => {
      // 无论拖进来的是不是文件，都要阻止默认导航
      event.preventDefault()
      depth = 0
      setDragActive(false)
      // 校验（是否 CSV / 是否为空）在 store 里做，失败会给出明确提示
      void openDroppedFiles(event.dataTransfer?.files ?? [])
    }

    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [openDroppedFiles])

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <SiteRail />
        <ChartStage />
        <SpecPanel />
      </div>
      <StatusBar />
      {/* 拖拽文件进入窗口时的整窗高亮提示 */}
      {dragActive && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay__card">
            <span className="drop-overlay__title">松开即可导入 CSV</span>
            <span className="drop-overlay__hint">支持 .csv / .txt，单个文件不超过 20MB</span>
          </div>
        </div>
      )}
      {/* 导出对话框全局只挂一次，菜单与工具栏通过 store 控制开合 */}
      <ExportDialog />
    </div>
  )
}
