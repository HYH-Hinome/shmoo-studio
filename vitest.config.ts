import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置。
 * - environment: 'node' —— 解析器与组件渲染（react-dom/server）都不需要真实 DOM，
 *   在 Node 下直接跑最接近“纯逻辑”的测试环境，速度也最快。
 * - 别名与 electron.vite.config.ts 保持一致，测试里可以写 @shared/... / @renderer/...
 * - 只收集 tests/ 下的用例，避免把将来的 e2e 脚本卷进来。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // 性能类用例（两份样例各解析一次）给足余量，避免 CI 抖动导致偶发失败
    testTimeout: 20000
  }
})
