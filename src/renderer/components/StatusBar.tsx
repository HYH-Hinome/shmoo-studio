import { useAppStore } from '../state/store'

/**
 * 底部状态栏：左侧显示当前操作状态与错误，右侧显示版本/平台等只读信息。
 * 桌面工具的习惯是把“系统状态”常驻可见，避免用户不知道当前在读什么。
 */
export function StatusBar(): JSX.Element {
  const statusText = useAppStore((s) => s.statusText)
  const error = useAppStore((s) => s.error)
  const appVersion = useAppStore((s) => s.appVersion)
  const platform = useAppStore((s) => s.platform)

  return (
    <footer className="statusbar">
      <span className="statusbar__dot" aria-hidden="true" />
      <span className="statusbar__text">{statusText}</span>
      {error ? <span className="statusbar__error">· {error}</span> : null}
      <span className="statusbar__spacer" />
      <span className="statusbar__meta">
        <span>v{appVersion}</span>
        <span>{platform}</span>
        <span>离线模式</span>
      </span>
    </footer>
  )
}
