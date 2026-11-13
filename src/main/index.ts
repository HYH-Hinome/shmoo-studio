import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { registerFileIpc } from './ipc/file'
import { registerExportIpc } from './ipc/export'
import { buildAppMenu } from './menu'

/** 是否开发模式：未打包即为开发模式，用于区分加载地址与安全策略 */
const isDev = !app.isPackaged

/** 主窗口引用；打包后单窗口，退出时置空 */
let mainWindow: BrowserWindow | null = null

/**
 * 生产环境注入 CSP。
 * 开发环境不加：Vite/React Refresh 会在 HTML 中注入内联脚本，加了会直接白屏。
 */
function applyProductionCsp(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self'"
          ].join('; ')
        ]
      }
    })
  })
}

/**
 * 显示并聚焦主窗口。
 *
 * 背景：外部启动器可能以隐藏窗口方式拉起首个实例，此时窗口虽然创建成功，
 * 但对用户完全不可见，后续双击只会静默退出，表现为“毫无反应”。
 * 第二个实例启动时调用本函数把已有窗口显式呈现出来。
 */
function revealMainWindow(): void {
  if (!mainWindow) return
  // 先显示（隐藏状态下 show() 才会让窗口出现），再从最小化恢复
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  // 置前 + 聚焦，避免窗口被其他程序压住而用户仍以为没反应
  mainWindow.focus()
  mainWindow.moveTop()
}

/** 创建主窗口 */
function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 680,
    show: false,
    backgroundColor: '#07090d',
    title: 'Shmoo Studio',
    // 隐藏系统标题栏，用渲染层的自绘标题栏；右上角保留原生窗口按钮（最小化/最大化/关闭）
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0f16',
      symbolColor: '#93a1b1',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow = win

  // 首帧渲染完成后再显示，避免深色应用常见的白屏闪烁
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
  })

  // 站内不允许打开新窗口；外部链接一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 禁止渲染层导航到非本应用页面（防止被 CSV 内容注入后跳转）
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = isDev && devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例：第二个实例启动时聚焦已有窗口，避免同时开多个进程写同一份配置
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 用户第二次启动时不再静默退出，而是把已有窗口显示/还原/置前；
    // 第二个实例本身仍会在下面 requestSingleInstanceLock 失败分支中退出。
    if (!mainWindow) {
      // 首个实例可能还没创建完窗口：等窗口创建后再呈现一次，避免这次点击被吞掉
      app.once('browser-window-created', () => revealMainWindow())
      return
    }
    revealMainWindow()
  })

  void app.whenReady().then(() => {
    // Windows 通知/任务栏归组需要与 electron-builder.yml 的 appId 保持一致
    // （来自 electron-builder skill 的明确要求）
    app.setAppUserModelId('com.shmoostudio.app')
    applyProductionCsp()
    registerFileIpc()
    registerExportIpc()
    buildAppMenu(() => mainWindow)
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
