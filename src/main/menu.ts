import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '../shared/types/api'

/**
 * 构建应用菜单。
 * 菜单项不直接操作文件，而是向渲染进程派发命令（'open-csv' / 'export-*'），
 * 保证“菜单”与“界面按钮”走同一条代码路径，避免两套逻辑分叉。
 */
export function buildAppMenu(getWindow: () => BrowserWindow | null): void {
  const send = (command: AppCommand) => () => {
    getWindow()?.webContents.send('app:command', command)
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 CSV…',
          accelerator: 'CmdOrCtrl+O',
          click: send('open-csv')
        },
        {
          label: '导出 PNG…',
          accelerator: 'CmdOrCtrl+Shift+P',
          // 阶段 ⑦ 才实现导出，这里先置灰，避免用户点了没反应
          enabled: false,
          click: send('export-png')
        },
        {
          label: '导出 PDF…',
          accelerator: 'CmdOrCtrl+P',
          enabled: false,
          click: send('export-pdf')
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Shmoo Studio',
          click: () => {
            const win = getWindow()
            const options: Electron.MessageBoxOptions = {
              type: 'info',
              title: '关于',
              message: 'Shmoo Studio',
              detail: `版本 ${app.getVersion()}\n离线 Shmoo 图分析工具（ATE）`,
              buttons: ['确定']
            }
            if (win) void dialog.showMessageBox(win, options)
            else void dialog.showMessageBox(options)
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
