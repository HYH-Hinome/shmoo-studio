import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * electron-vite 配置：一份配置同时覆盖主进程 / 预加载 / 渲染进程。
 * - 主进程与预加载：externalizeDepsPlugin 让 node 侧依赖保持 external，避免被打包成 ESM
 * - 渲染进程：React 插件 + 路径别名（@shared / @renderer）
 * 产物统一输出到 out/ 目录：out/main、out/preload、out/renderer
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      // 主进程的矢量 PDF 导出复用了渲染进程的纯绘制模块（colors/geometry/oneD），
      // 这些模块通过 @shared 别名引用共享类型与判定逻辑，因此主进程也要配置别名。
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
