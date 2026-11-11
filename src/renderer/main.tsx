import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './theme/tokens.css'
import './styles/app.css'

// 渲染进程入口：挂载 React 根节点
const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// 开发模式下的演示数据入口（?demo=1）。生产构建时该分支被静态剔除，
// 对应的 dev/demo.ts 与样例 CSV 都不会进入产物。
if (import.meta.env.DEV) {
  void import('./dev/demo').then((module) => module.maybeLoadDemo())
}
