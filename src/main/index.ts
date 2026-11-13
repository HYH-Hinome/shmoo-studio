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

/**
 * 强制让主窗口真正可见。
 *
 * 背景（Windows 平台的已知坑）：
 * 若父进程通过 STARTUPINFO（STARTF_USESHOWWINDOW + SW_HIDE）把本程序隐藏拉起，
 * Windows 会把本进程**第一次** ShowWindow 的显示方式悄悄改写成"隐藏"。
 * 而 Electron 的 BrowserWindow 用客户端缓存记录可见状态：show() 调用过一次后
 * 内部就认为已可见，后续 show() 不会再下发原生 ShowWindow。结果就是
 * "进程在跑、页面渲染完、show() 也执行了，但原生窗口 WS_VISIBLE=0"，
 * 用户看到的是双击没反应（同条件下 Rust/winit 程序正常，因为它每次都会下发
 * 原生 ShowWindow，而 Electron 只下发一次）。
 *
 * 兜底方案：show() 之后再补一次 hide() → show()。
 * 系统只会覆盖进程的第一次 ShowWindow，第二次起会正常下发 SW_HIDE / SW_SHOW，
 * 窗口因此能真正显示出来。
 *
 * 正常启动时这两次调用同步完成，中间没有消息泵也没有绘制机会，用户不会看到闪烁；
 * 不改窗口尺寸、位置、最大化状态与标题栏样式，也不影响 second-instance 的聚焦逻辑。
 *
 * 说明：Electron 没有公开"原生窗口是否真的可见"的查询接口，win.isVisible()
 * 返回的恰恰是上面那个客户端缓存值（问题本身），所以这里不做条件判断。
 */
function forceShowWindow(win: BrowserWindow): void {
  win.show()
  win.hide()
  win.show()
  // 部分隐藏启动场景下第二次 SW_SHOW 会被系统按"最小化"呈现（实测窗口
  // WS_VISIBLE=1 但 IsIconic=1，任务栏有图标却看不到界面），再补一次还原；
  // 正常启动时窗口本来就不是最小化，restore() 是空操作。
  win.restore()
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

  // 首次呈现只允许执行一次：ready-to-show 与下面的兜底定时器可能先后触发
  let revealed = false
  const revealOnce = (): void => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    forceShowWindow(win)
  }

  // 正常路径：首帧渲染完成后再显示，避免深色应用常见的白屏闪烁
  win.once('ready-to-show', revealOnce)

  // 兜底路径：被 STARTUPINFO/SW_HIDE 隐藏拉起时，Chromium 因为原生窗口不可见
  // 迟迟不产生首帧，ready-to-show 根本不会触发（实测隐藏启动 10s 内一次都没触发），
  // 窗口就永远是隐形的。这里用定时器兜底，到点直接强制显示；
  // 正常启动时 ready-to-show 通常远早于 2s，会先把 revealed 置位，定时器到点后空转。
  const revealFallbackTimer = setTimeout(revealOnce, 2000)

  win.on('closed', () => {
    clearTimeout(revealFallbackTimer)
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
