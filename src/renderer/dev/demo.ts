import type { ShmooDataset } from '@shared/types/shmoo'
import type { ChartBench } from '../chart/perf'
import { DEFAULT_PADDING, cellCenter, computeGeometry } from '../chart/geometry'
import { computeMarginTints } from '../chart/colors'
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
 *   ?demo=1&sample=1d        载入 1D 样例 samples/sample-1d-vdd.csv
 *   ?demo=1&sample=1d&form=curve  1D 以连续曲线形态打开（默认色带）
 *   ?demo=1&sample=window    载入双边窗口样例（低/高 VDD 两端都失效）
 *   ?demo=1&sample=pattern   载入 0/1 pattern 样例（spec: min=1 max=1，热力按钮会置灰）
 *   ?demo=1&hover=21,9       载入后在该格子上触发一次 pointermove（截图用，越界会被忽略）
 *                           1D 数据集写成 ?hover=7（按采样下标吸附）
 *   ?demo=1&slice=row:12     载入 2D 样例后直接切出第 12 行（列切片写 slice=col:8）
 *   ?demo=1&bench=1          额外跑 1920×1080 @ DPR2 的静态层压测，结果写入 window.__shmooBench
 *
 * 生产构建时 main.tsx 中的 `import.meta.env.DEV` 分支会被静态剔除，
 * 本文件连同样例 CSV 都不会进入产物。
 */

/** 演示数据文件名（真实样例，不是随机生成的假数据） */
const DEMO_2D = { file: 'sample-2d-mcu.csv', loader: () => import('../../../samples/sample-2d-mcu.csv?raw') }
const DEMO_1D = { file: 'sample-1d-vdd.csv', loader: () => import('../../../samples/sample-1d-vdd.csv?raw') }
const DEMO_WINDOW = {
  file: 'sample-2d-window.csv',
  loader: () => import('../../../samples/sample-2d-window.csv?raw')
}
const DEMO_PATTERN = {
  file: 'sample-2d-pattern.csv',
  loader: () => import('../../../samples/sample-2d-pattern.csv?raw')
}

/** 演示样例标识 → 文件与加载器 */
type DemoSample = '2d' | '1d' | 'window' | 'pattern'

const DEMO_SAMPLES: Record<DemoSample, { file: string; loader: () => Promise<{ default: string }> }> = {
  '2d': DEMO_2D,
  '1d': DEMO_1D,
  window: DEMO_WINDOW,
  pattern: DEMO_PATTERN
}

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
async function loadDemoDataset(sample: DemoSample): Promise<ShmooDataset | null> {
  const source = DEMO_SAMPLES[sample]
  const [{ default: text }, { parseCsvInWorker }] = await Promise.all([
    source.loader(),
    import('../lib/parseCsv')
  ])

  const { dataset, report } = await parseCsvInWorker({
    text,
    fileName: source.file,
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
  // store 本体也暴露出去：切片方向、悬停行等状态便于自动化断言
  window.__shmooStore = useAppStore
  return dataset
}

/**
 * 按 `?hover=ix,iy` 在图表上派发一次 pointermove。
 * 2D 用两个下标；1D 只需一个采样下标（`?hover=7`），内部按 iy = 0 处理。
 */
async function applyHover(dataset: ShmooDataset, spec: string): Promise<void> {
  const parts = spec.split(',').map((part) => Number(part))
  const ix = parts[0]
  const iy = dataset.kind === '1d' ? 0 : parts[1]
  if (!Number.isInteger(ix) || !Number.isInteger(iy)) {
    console.warn('[demo] hover 参数应为 "xIndex,yIndex"（1D 可只写 xIndex）', spec)
    return
  }
  // 行列数由数据决定（30×30 只是样例），这里按真实轴长做越界保护，
  // 避免换数据集后 hover 坐标越界、cellCenter 取到 edges 之外的 NaN。
  const nx = dataset.xAxis.values.length
  const ny = dataset.yAxis?.values.length ?? 1
  if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) {
    console.warn(`[demo] hover 索引越界：(${ix}, ${iy})，当前网格 ${nx}×${ny}`)
    return
  }

  const container = await waitFor(() => document.querySelector<HTMLElement>('.shmoo-chart'))
  if (!container) return

  // 等画布完成首帧测量：canvas.width 还是默认值 300 时说明 ResizeObserver 尚未写入尺寸，
  // 此时组件会忽略 pointermove（尺寸 < 2 直接返回）。
  await waitFor(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-chart-canvas]')
    return canvas && canvas.width > 100 ? canvas : null
  })

  const width = container.clientWidth
  const height = container.clientHeight
  const geometry = computeGeometry(
    width,
    height,
    DEFAULT_PADDING,
    dataset.xAxis.values,
    dataset.yAxis?.values ?? [0]
  )
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
    tint: computeMarginTints(site, dataset.spec),
    motion: { enabled: false, delaySpan: 0, cellDuration: 0, elapsed: 0 }
  }

  // 预热 5 次（首次会做字体测量与路径构建），不计入结果
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

  // 只接受白名单内的取值，避免随手写个 ?sample=xxx 导致动态 import 报错
  const sampleRaw = params.get('sample')
  const sample: DemoSample =
    sampleRaw === '1d' || sampleRaw === 'window' || sampleRaw === 'pattern' ? sampleRaw : '2d'
  const dataset = await loadDemoDataset(sample)
  if (!dataset) return

  const mode = params.get('mode')
  if (mode === 'heat' || mode === 'binary') {
    useAppStore.setState({ colorMode: mode })
  }

  const form = params.get('form')
  if (form === 'band' || form === 'curve') {
    useAppStore.setState({ oneDForm: form })
  }

  // 二值配色已在阶段 ③c 定稿为 A′（青绿 PASS / 正红 FAIL），不再提供版本切换参数

  // 等图表挂载后再做悬停/压测，避免在空态上操作
  await waitFor(() => document.querySelector<HTMLElement>('.shmoo-chart'))

  const hover = params.get('hover')
  if (hover) await applyHover(dataset, hover)

  // 切片：?slice=row:12 / ?slice=col:8（截图与自检用，不写 index 时默认第 0 行）
  const sliceParam = params.get('slice')
  if (sliceParam && dataset.kind === '2d') {
    const [axisRaw, indexRaw] = sliceParam.includes(':') ? sliceParam.split(':') : ['row', sliceParam]
    const axis = axisRaw === 'col' ? 'col' : 'row'
    const index = Number(indexRaw)
    if (Number.isInteger(index)) {
      useAppStore.getState().openSlice({ axis, index })
      // 等切片视图真正挂载：面包屑是切片视图独有的元素
      await waitFor(() => document.querySelector('.crumb'))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    } else {
      console.warn('[demo] slice 参数应为 "row:index" 或 "col:index"', sliceParam)
    }
  }

  if (params.get('bench') === '1' && dataset.kind === '2d') runBench(dataset)
}
