import type { ShmooDataset } from '@shared/types/shmoo'
import type { ChartBench } from '../chart/perf'
import { DEFAULT_PADDING, cellCenter, computeGeometry } from '../chart/geometry'
import { drawStaticLayer } from '../chart/render2d'
import { useAppStore } from '../state/store'

/**
 * 开发用演示数据加载器（仅 `import.meta.env.DEV` 生效）。
 *
 * 背景：普通浏览器里没有 preload，`window.shmoo.openCsv()` 走不通，
 * 视觉验收/截图无法通过原生文件对话框载入数据。因此提供一个只在开发模式存在的入口：
 *
 *   ?demo=1                  载入 samples/sample-2d-mcu.csv（二值模式）
 *   ?demo=1&mode=heat        以热力模式打开
 *   ?demo=1&hover=21,9       载入后在该格子上触发一次 pointermove（截图用）
 *   ?demo=1&bench=1          额外跑 1920×1080 @ DPR2 的静态层压测，结果写入 window.__shmooBench
 *
 * 生产构建时 main.tsx 中的 `import.meta.env.DEV` 分支会被静态剔除，
 * 本文件连同样例 CSV 都不会进入产物。
 */

/** 演示数据文件名（真实样例，不是随机生成的假数据） */
const DEMO_FILE = 'sample-2d-mcu.csv'

/** 轮询等待元素出现（React 挂载与首帧测量需要一点时间） */
async function waitFor<T>(getter: () => T | null, timeout = 4000): Promise<T | null> {
  const startedAt = performance.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      const value = getter()
      if (value || performance.now() - startedAt > timeout) {
        resolve(value)
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

/** 解析并写入 store（只做阶段 ② 已有的解析链路，不伪造数据） */
async function loadDemoDataset(): Promise<ShmooDataset | null> {
  const [{ default: text }, { parseCsvInWorker }] = await Promise.all([
    import('../../../samples/sample-2d-mcu.csv?raw'),
    import('../lib/parseCsv')
  ])

  const { dataset, report } = await parseCsvInWorker({
    text,
    fileName: DEMO_FILE,
    filePath: null
  })
  if (!dataset) {
    console.warn('[demo] 样例解析失败', report)
    return null
  }

  useAppStore.setState({
    dataset,
    report,
    activeSiteId: dataset.sites[0]?.siteId ?? null,
    spec: dataset.spec,
    fileName: dataset.fileName,
    statusText: `演示数据 · ${dataset.kind.toUpperCase()} · ${dataset.sites.length} site`,
    error: null
  })

  // 仅开发模式：把演示数据集挂到 window，供截图/像素自检脚本核对“画出来的颜色 = 数据本身”
  window.__shmooDemo = { dataset, site: dataset.sites[0] }
  return dataset
}

/**
 * 按 `?hover=ix,iy` 在图表上派发一次 pointermove，
 * 让十字线/浮层处于“悬停中”的状态，便于截取交互态截图。
 */
async function applyHover(dataset: ShmooDataset, spec: string): Promise<void> {
  const [ix, iy] = spec.split(',').map((part) => Number(part))
  if (!Number.isInteger(ix) || !Number.isInteger(iy)) {
    console.warn('[demo] hover 参数应为 "xIndex,yIndex"', spec)
    return
  }

  const container = await waitFor(() => document.querySelector<HTMLElement>('.shmoo-chart'))
  if (!container || !dataset.yAxis) return

  // 等画布完成首帧测量：canvas.width 还是默认值 300 时说明 ResizeObserver 尚未写入尺寸，
  // 此时组件会忽略 pointermove（尺寸 < 2 直接返回）。
  await waitFor(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-chart-canvas]')
    return canvas && canvas.width > 100 ? canvas : null
  })

  const width = container.clientWidth
  const height = container.clientHeight
  const geometry = computeGeometry(width, height, DEFAULT_PADDING, dataset.xAxis.values, dataset.yAxis.values)
  const center = cellCenter(geometry, ix, iy)
  const rect = container.getBoundingClientRect()

  // 尺寸测量 → React 状态更新 → 交互层重绘需要一帧；
  // 这里重复派发几次，直到浮层出现，避免和挂载时序抢跑。
  for (let attempt = 0; attempt < 20; attempt++) {
    container.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: rect.left + container.clientLeft + center.x,
        clientY: rect.top + container.clientTop + center.y
      })
    )
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (document.querySelector('.chart-tip.is-visible')) return
  }
}

/** 统计工具：中位数 / p95 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))
  return sorted[index]
}

/**
 * 1920×1080 @ DPR2 的静态层压测：
 * 按文档的性能红线（1080p、DPR=2）直接跑 drawStaticLayer，
 * 这比窗口实际尺寸更严格，也便于和文档指标对比。
 */
function runBench(dataset: ShmooDataset): void {
  if (!dataset.yAxis) return
  const width = 1920
  const height = 1080
  const dpr = 2
  const runs = 50

  const canvas = document.createElement('canvas')
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const site = dataset.sites[0]
  const geometry = computeGeometry(width, height, DEFAULT_PADDING, dataset.xAxis.values, dataset.yAxis.values)
  const input = {
    geometry,
    xAxis: dataset.xAxis,
    yAxis: dataset.yAxis,
    site,
    valueLabel: dataset.valueLabel,
    valueUnit: dataset.valueUnit,
    mode: 'binary' as const,
    motion: { enabled: false, delaySpan: 0, cellDuration: 0, elapsed: 0 }
  }

  // 预热 5 次（首次会创建斜纹 pattern、字体测量等），不计入结果
  for (let i = 0; i < 5; i++) drawStaticLayer(ctx, { width, height, dpr }, input)

  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const startedAt = performance.now()
    drawStaticLayer(ctx, { width, height, dpr }, input)
    samples.push(performance.now() - startedAt)
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const bench: ChartBench = {
    width,
    height,
    dpr,
    cells: dataset.xAxis.values.length * dataset.yAxis.values.length,
    runs,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1]
  }
  window.__shmooBench = bench
  console.info('[demo] 静态层压测', bench)
}

/** 入口：main.tsx 在 DEV 下动态调用 */
export async function maybeLoadDemo(): Promise<void> {
  if (!import.meta.env.DEV) return

  const params = new URLSearchParams(window.location.search)
  if (params.get('demo') !== '1') return

  const dataset = await loadDemoDataset()
  if (!dataset) return

  const mode = params.get('mode')
  if (mode === 'heat' || mode === 'binary') {
    useAppStore.setState({ colorMode: mode })
  }

  // 等图表挂载后再做悬停/压测，避免在空态上操作
  await waitFor(() => document.querySelector<HTMLElement>('.shmoo-chart'))

  const hover = params.get('hover')
  if (hover) await applyHover(dataset, hover)

  if (params.get('bench') === '1') runBench(dataset)
}
