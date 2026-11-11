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
