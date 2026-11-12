import type { ShmooDataset, SiteGrid, SpecLimit } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS, CELL_UNKNOWN } from '@shared/types/shmoo'
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
 *   ?demo=1&lock=21,9        截“锁定读数”用：直接把该格设为锁定态（真实单击由单测/浏览器实测覆盖）
 *   ?demo=1&box=8,6,16,14    截“框选统计”用：直接写入矩形框选（真实拖拽同上）
 *   ?demo=1&slice=row:12     载入 2D 样例后直接切出第 12 行（列切片写 slice=col:8）
 *   ?demo=1&spec=min=740,max=860  载入后应用一份临时 spec（截图“编辑后”用，等价于界面输入）
 *   ?demo=1&spec=min=780,max=840  1D 双边收窄示例：色带变成红-绿-红
 *   ?demo=1&bench=1          额外跑 1920×1080 @ DPR2 的静态层压测，结果写入 window.__shmooBench
 *   ?demo=1&bench=1&grid=100 用合成 100×100 网格压测（默认用样例的 30×30）
 *   ?demo=1&interaction-perf=1  合成 60 次跨格 pointermove，实测交互层重绘耗时并显示在页面上
 *   ?demo=1&spec-perf=1      实测“改 spec → 重算 → 重绘”耗时（可配合 grid=100）
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

/**
 * 解析并写入 store（只做阶段 ② 已有的解析链路，不伪造数据）。
 *
 * 演示入口刻意使用同步解析（parseShmooCsv），而不是正式导入用的 Worker：
 *  - 样例只有几十 KB，同步解析约几毫秒，不影响截图等待；
 *  - 无头浏览器截图 / 自动化脚本里，Worker 的完成时机不稳定（虚拟时间下尤其明显），
 *    会出现“截图时数据还没进来”的假失败；
 *  - 正式导入路径（App 的打开文件）仍然走 parseCsvInWorker，这里只是演示加载器。
 */
async function loadDemoDataset(sample: DemoSample): Promise<ShmooDataset | null> {
  const source = DEMO_SAMPLES[sample]
  const [{ default: text }, { parseShmooCsv }] = await Promise.all([
    source.loader(),
    import('@shared/csv/parser')
  ])

  const { dataset, report } = parseShmooCsv(text, {
    fileName: source.file,
    filePath: null,
    fileSize: text.length
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
    // 演示数据也记录“文件原始 spec”，让规格面板的重置按钮在 dev 下真实可用
    fileSpec: dataset.spec,
    specHistory: [],
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

/**
 * 把格子索引换算成浏览器坐标（含容器偏移），并等待画布完成首帧测量。
 * hover / lock / box 三个演示入口共用，避免几何计算各写一份。
 */
async function locateCell(
  dataset: ShmooDataset,
  ix: number,
  iy: number
): Promise<{ container: HTMLElement; clientX: number; clientY: number } | null> {
  const nx = dataset.xAxis.values.length
  const ny = dataset.yAxis?.values.length ?? 1
  if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) {
    console.warn(`[demo] 索引越界：(${ix}, ${iy})，当前网格 ${nx}×${ny}`)
    return null
  }

  const container = await waitFor(() => document.querySelector<HTMLElement>('.shmoo-chart'))
  if (!container) return null
  await waitFor(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-chart-canvas]')
    return canvas && canvas.width > 100 ? canvas : null
  })

  const geometry = computeGeometry(
    container.clientWidth,
    container.clientHeight,
    DEFAULT_PADDING,
    dataset.xAxis.values,
    dataset.yAxis?.values ?? [0]
  )
  const center = cellCenter(geometry, ix, iy)
  const rect = container.getBoundingClientRect()
  return {
    container,
    clientX: rect.left + container.clientLeft + center.x,
    clientY: rect.top + container.clientTop + center.y
  }
}

/**
 * 截“锁定读数”用：直接写入锁定状态。
 *
 * 为什么不是模拟点击：无头浏览器 + 虚拟时间的截图流程里，250ms 的单击判定定时器
 * 不保证在截图前执行，会得到“没有锁定描边”的假失败。真实点击路径（含单/双击区分）
 * 由 tests/chart-interaction.test.ts 的 classifyClick 与浏览器实测覆盖，
 * 这里只负责把画面稳定地摆到“锁定后”的状态。
 */
async function applyLock(dataset: ShmooDataset, spec: string): Promise<void> {
  const parts = spec.split(',').map((part) => Number(part))
  const ix = parts[0]
  const iy = dataset.kind === '1d' ? 0 : parts[1]
  if (!Number.isInteger(ix) || !Number.isInteger(iy)) {
    console.warn('[demo] lock 参数应为 "xIndex,yIndex"', spec)
    return
  }
  const point = await locateCell(dataset, ix, iy)
  if (!point) return
  useAppStore.getState().setSelection({ ix, iy })
  // 等一帧，确保交互层按新锁定格重绘后再截图
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * 截“框选统计”用：直接写入框选范围（起点 → 终点）。
 * 与 applyLock 同理：状态直写保证截图稳定，真实拖拽路径由浏览器交互实测覆盖。
 */
async function applyBox(dataset: ShmooDataset, spec: string): Promise<void> {
  const parts = spec.split(',').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    console.warn('[demo] box 参数应为 "x0,y0,x1,y1"', spec)
    return
  }
  const [x0, y0, x1, y1] = parts
  const start = await locateCell(dataset, x0, y0)
  const end = await locateCell(dataset, x1, y1)
  if (!start || !end) return
  useAppStore.getState().setBox({
    anchor: { ix: x0, iy: y0 },
    focus: { ix: x1, iy: y1 }
  })
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

/** 统计工具：中位数 / p95 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))
  return sorted[index]
}

/**
 * 合成一个 n×n 的站点，用于 100×100 性能压测。
 * 形状做成“一个大通过区 + 一条失效带 + 少量缺测点”，接近真实 Shmoo 的分布，
 * 而不是棋盘格（棋盘格会产生上千个微小连通区，属于不现实的极端场景）。
 */
function syntheticSite(nx: number, ny: number): SiteGrid {
  const value = new Float32Array(nx * ny)
  const pass = new Uint8Array(nx * ny)
  let seed = 987654321
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }

  let knownCount = 0
  let passCount = 0
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const index = iy * nx + ix
      const dx = (ix - nx / 2) / (nx / 2)
      const dy = (iy - ny / 2) / (ny / 2)
      const radius = Math.hypot(dx, dy)
      // 中心通过、外圈失效，并在右上角挖一个缺测小区
      const unknown = radius > 0.35 && ix > nx * 0.72 && iy > ny * 0.72 ? random() < 0.4 : false
      if (unknown) {
        value[index] = Number.NaN
        pass[index] = CELL_UNKNOWN
        continue
      }
      const ok = radius < 0.62 + (random() - 0.5) * 0.08
      value[index] = ok ? 800 + random() * 40 : 600 + random() * 40
      pass[index] = ok ? CELL_PASS : CELL_FAIL
      knownCount++
      if (ok) passCount++
    }
  }

  return {
    siteId: 'SITE_100',
    siteLabel: 'SITE_100',
    value,
    pass,
    valueRange: { min: 600, max: 850 },
    knownCount,
    passCount
  }
}

/**
 * 1920×1080 @ DPR2 的静态层压测：
 * 按文档的性能红线（1080p、DPR=2）直接跑 drawStaticLayer，
 * 这比窗口实际尺寸更严格，也便于和文档指标对比。
 *
 * @param grid 大于 0 时忽略数据集本身，改用该边长的合成网格（用于 100×100 回归）
 */
function runBench(dataset: ShmooDataset, grid = 0): void {
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

  const nx = grid > 0 ? grid : dataset.xAxis.values.length
  const ny = grid > 0 ? grid : dataset.yAxis.values.length
  const xAxis = grid > 0 ? { ...dataset.xAxis, values: Array.from({ length: nx }, (_, i) => i) } : dataset.xAxis
  const yAxis = grid > 0 ? { ...dataset.yAxis, values: Array.from({ length: ny }, (_, j) => j) } : dataset.yAxis
  const site = grid > 0 ? syntheticSite(nx, ny) : dataset.sites[0]

  const geometry = computeGeometry(width, height, DEFAULT_PADDING, xAxis.values, yAxis.values)
  const input = {
    geometry,
    xAxis,
    yAxis,
    site,
    valueLabel: dataset.valueLabel,
    valueUnit: dataset.valueUnit,
    mode: 'binary' as const,
    // 合成网格是连续值：保留 margin 明度调制这条真实路径
    flatBinary: false,
    tint: computeMarginTints(site, dataset.spec),
    motion: { enabled: false, elapsed: 0 }
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
    // 用实际参与绘制的网格（grid 参数会覆盖数据集尺寸），否则 100×100 压测会误报 900 格
    cells: nx * ny,
    runs,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1]
  }
  window.__shmooBench = bench
  console.info('[demo] 静态层压测', bench)
}

/**
 * 交互层耗时探针（仅 dev，`?demo=1&interaction-perf=1`）。
 *
 * 目的：验证“鼠标移动只重绘交互层，且不影响帧率”这条验收项。
 * 实现方式不依赖外部 CDP：
 *  - 在页面内合成 60 次跨格 pointermove（真正走组件的指针处理与 repaint 调度）；
 *  - 等每帧 rAF 落地后，从 window.__shmooPerf.interaction 取真实绘制耗时；
 *  - 统计中位 / p95 / max，并把结果写到页面角标与 document.title，截图或读标题都能拿到。
 * 同时记录静态层 / 边界层的采样数变化，用于证明移动鼠标不会触发这两层重绘。
 */
async function runInteractionProbe(dataset: ShmooDataset): Promise<void> {
  const container = await waitFor(() => document.querySelector<HTMLElement>('.shmoo-chart'))
  if (!container || dataset.kind !== '2d' || !dataset.yAxis) return

  // 先清掉锁定/框选：锁定态下组件会刻意跳过 hover 重绘，测不到交互层开销
  useAppStore.getState().clearInteraction()

  const rect = container.getBoundingClientRect()
  const geometry = computeGeometry(
    container.clientWidth,
    container.clientHeight,
    DEFAULT_PADDING,
    dataset.xAxis.values,
    dataset.yAxis.values
  )
  const nx = dataset.xAxis.values.length
  const ny = dataset.yAxis.values.length
  const perf = window.__shmooPerf
  if (!perf) return

  // 等入场动画结束，避免把 stagger 的静态层重绘算到交互层头上
  await new Promise<void>((resolve) => setTimeout(resolve, 700))

  const staticBefore = perf.static.length
  const boundaryBefore = perf.boundary.length
  perf.interaction.length = 0

  for (let i = 0; i < 60; i++) {
    const ix = i % nx
    const iy = Math.floor(i / nx) % ny
    const center = cellCenter(geometry, ix, iy)
    container.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: rect.left + container.clientLeft + center.x,
        clientY: rect.top + container.clientTop + center.y
      })
    )
    // 每格一帧：确保测到的是“每次移动一次重绘”的稳定值，而不是同一帧内的合并结果
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }

  const sorted = [...perf.interaction].sort((a, b) => a - b)
  const result = {
    moves: 60,
    samples: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    staticRedraws: perf.static.length - staticBefore,
    boundaryRedraws: perf.boundary.length - boundaryBefore
  }

  const text =
    `交互层重绘 · 60 次移动\n` +
    `median ${result.median.toFixed(3)} ms · p95 ${result.p95.toFixed(3)} ms · max ${result.max.toFixed(3)} ms\n` +
    `static +${result.staticRedraws} · boundary +${result.boundaryRedraws} · samples ${result.samples}`

  // 固定角标：无头截图直接可读；document.title 供 dump-dom / 外部脚本读取
  const badge = document.createElement('div')
  badge.id = 'perf-badge'
  badge.textContent = text
  badge.style.cssText = [
    'position:fixed',
    'left:12px',
    'top:12px',
    'z-index:9999',
    'padding:10px 12px',
    'background:rgba(6,10,14,0.92)',
    'border:1px solid rgba(111,227,239,0.7)',
    'border-radius:6px',
    'color:#eaf6ff',
    'font:12px/1.5 "JetBrains Mono",monospace',
    'font-variant-numeric:tabular-nums',
    'white-space:pre',
    'pointer-events:none'
  ].join(';')
  document.body.appendChild(badge)
  document.title = `PERF median=${result.median.toFixed(3)} p95=${result.p95.toFixed(3)} max=${result.max.toFixed(3)} static=${result.staticRedraws} boundary=${result.boundaryRedraws}`
  console.info('[demo] 交互层耗时', result)
}

/**
 * 阶段 ⑥ 性能探针（仅 dev，`?demo=1&spec-perf=1`，可加 `&grid=100`）。
 *
 * 测三件事：
 *  1. 纯重算耗时：直接调用 applySpecToDataset，30 次取分位；
 *  2. 静态/边界/交互三层重绘耗时：从 window.__shmooPerf 读 rAF 内真实绘制时长；
 *  3. 端到端算力：flushSync 提交 + 三层绘制之和（不含等待显示器刷新的空转）。
 * 目标：100×100 端到端 < 50ms（交互级）。
 */
async function runSpecPerfProbe(dataset: ShmooDataset): Promise<void> {
  if (dataset.kind !== '2d' || !dataset.yAxis) return
  const perf = window.__shmooPerf

  // 等入场动画结束，避免把 stagger 的静态层绘制混进采样
  await new Promise<void>((resolve) => setTimeout(resolve, 1200))

  const { applySpecToDataset } = await import('@shared/spec/apply')
  const range = dataset.sites[0]?.valueRange ?? { min: 0, max: 1 }
  const span = range.max - range.min || 1
  const specs: SpecLimit[] = [
    { mode: 'window', min: range.min + span * 0.1, max: range.max - span * 0.02 },
    { mode: 'window', min: range.min + span * 0.32, max: range.max - span * 0.18 }
  ]

  // 1) 纯判定重算（不涉及 React / 画布）
  const compute: number[] = []
  let cursor = dataset
  for (let i = 0; i < 30; i++) {
    const startedAt = performance.now()
    cursor = applySpecToDataset(cursor, specs[i % 2])
    compute.push(performance.now() - startedAt)
  }

  // 2) 端到端算力 = React 同步提交 + 三层画布绘制。
  //    用 flushSync 保证提交同步完成；画布本身由 rAF 调度，所以等一帧后
  //    从 __shmooPerf 读取本次 rAF 的真实绘制耗时，只累加计算时间，
  //    不把“等显示器刷新”的空转算进结果（后台标签页节流也不会污染分位数）。
  const { flushSync } = await import('react-dom')
  const commit: number[] = []
  const draw: number[] = []
  const work: number[] = []
  for (let i = 0; i < 10; i++) {
    const beforeStatic = perf?.static.length ?? 0
    const beforeBoundary = perf?.boundary.length ?? 0
    const beforeInteraction = perf?.interaction.length ?? 0
    const startedAt = performance.now()
    flushSync(() => {
      useAppStore.getState().applySpec(specs[i % 2])
    })
    const commitMs = performance.now() - startedAt

    // 等本帧 rAF：repaint('all') 在这里真正落到三层 canvas
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const sumLayer = (samples: number[] | undefined, from: number): number =>
      samples ? samples.slice(from).reduce((total, ms) => total + ms, 0) : 0
    const drawMs =
      sumLayer(perf?.static, beforeStatic) +
      sumLayer(perf?.boundary, beforeBoundary) +
      sumLayer(perf?.interaction, beforeInteraction)

    commit.push(commitMs)
    draw.push(drawMs)
    work.push(commitMs + drawMs)
  }

  const sortedCompute = [...compute].sort((a, b) => a - b)
  const sortedCommit = [...commit].sort((a, b) => a - b)
  const sortedDraw = [...draw].sort((a, b) => a - b)
  const sortedWork = [...work].sort((a, b) => a - b)
  const result = {
    cells: dataset.xAxis.values.length * dataset.yAxis.values.length,
    computeMedian: quantile(sortedCompute, 0.5),
    commitMedian: quantile(sortedCommit, 0.5),
    drawMedian: quantile(sortedDraw, 0.5),
    e2eMedian: quantile(sortedWork, 0.5),
    e2eP95: quantile(sortedWork, 0.95),
    e2eMax: sortedWork[sortedWork.length - 1] ?? 0,
    samples: work.length
  }

  const text =
    `spec 重算 + 重绘 · ${result.cells} 格\n` +
    `compute ${result.computeMedian.toFixed(2)} ms · commit ${result.commitMedian.toFixed(2)} ms · draw ${result.drawMedian.toFixed(2)} ms\n` +
    `端到端 median ${result.e2eMedian.toFixed(1)} ms · p95 ${result.e2eP95.toFixed(1)} ms · max ${result.e2eMax.toFixed(1)} ms`

  const badge = document.createElement('div')
  badge.id = 'perf-badge'
  badge.textContent = text
  badge.style.cssText = [
    'position:fixed',
    'left:12px',
    'top:12px',
    'z-index:9999',
    'padding:10px 12px',
    'background:rgba(6,10,14,0.92)',
    'border:1px solid rgba(111,227,239,0.7)',
    'border-radius:6px',
    'color:#eaf6ff',
    'font:12px/1.5 "JetBrains Mono",monospace',
    'font-variant-numeric:tabular-nums',
    'white-space:pre',
    'pointer-events:none'
  ].join(';')
  document.body.appendChild(badge)
  document.title =
    `SPEC-PERF compute=${result.computeMedian.toFixed(2)} draw=${result.drawMedian.toFixed(2)}` +
    ` e2e=${result.e2eMedian.toFixed(1)} p95=${result.e2eP95.toFixed(1)} max=${result.e2eMax.toFixed(1)}` +
    ` cells=${result.cells}`
  console.info('[demo] spec 重算+重绘耗时', result)
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
  let dataset = await loadDemoDataset(sample)
  if (!dataset) return

  // 合成网格显示：?demo=1&grid=100
  // 100×100 这类小尺寸下，圆角半径会自适应收紧、格缝是否还看得见，必须用真实网格验证。
  // 这里把样例的轴与站点替换为合成数据（与压测共用 syntheticSite），
  // 渲染链路完全不变；标题里标注“合成”，避免截图被误认为真实样例。
  const gridParam = Number.parseInt(params.get('grid') ?? '0', 10)
  if (Number.isFinite(gridParam) && gridParam > 0 && dataset.kind === '2d' && dataset.yAxis) {
    const gridSite = syntheticSite(gridParam, gridParam)
    const synthetic = {
      ...dataset,
      title: `${dataset.title} · 合成 ${gridParam}×${gridParam}`,
      xAxis: { ...dataset.xAxis, values: Array.from({ length: gridParam }, (_, i) => i) },
      yAxis: { ...dataset.yAxis, values: Array.from({ length: gridParam }, (_, j) => j) },
      sites: [gridSite]
    }
    useAppStore.setState({ dataset: synthetic, activeSiteId: gridSite.siteId, spec: synthetic.spec, fileSpec: synthetic.spec, specHistory: [] })
    // 自检脚本读的是 window 上的引用，必须同步替换，否则像素断言会按 30×30 的几何去取样
    window.__shmooDemo = { dataset: synthetic, site: gridSite }
    dataset = synthetic
  }

  // 1D 二值样例：?demo=1&sample=pattern&row1d=12
  // 现有样例里没有“1D 二值”数据，切片视图又固定画曲线（form 被强制为 curve），
  // 所以这里把 2D 的指定行抽成真正的 1D 数据集，用来验证“1D 色带 + 饱和平涂”。
  const row1d = Number.parseInt(params.get('row1d') ?? '', 10)
  if (Number.isInteger(row1d) && dataset.kind === '2d' && dataset.yAxis) {
    const nx = dataset.xAxis.values.length
    const ny = dataset.yAxis.values.length
    const row = row1d >= 0 && row1d < ny ? row1d : 0
    const source = dataset.sites[0]
    const value = new Float32Array(nx)
    const pass = new Uint8Array(nx)
    let knownCount = 0
    let passCount = 0
    for (let ix = 0; ix < nx; ix++) {
      const index = row * nx + ix
      value[ix] = source.value[index]
      pass[ix] = source.pass[index]
      if (pass[ix] !== CELL_UNKNOWN) {
        knownCount++
        if (pass[ix] === CELL_PASS) passCount++
      }
    }
    const oneD = {
      ...dataset,
      kind: '1d' as const,
      title: `${dataset.title} · 第 ${row} 行`,
      yAxis: null,
      sites: [{ ...source, value, pass, valueRange: source.valueRange, knownCount, passCount }]
    }
    useAppStore.setState({ dataset: oneD, activeSiteId: oneD.sites[0].siteId, spec: oneD.spec, fileSpec: oneD.spec, specHistory: [] })
    window.__shmooDemo = { dataset: oneD, site: oneD.sites[0] }
    dataset = oneD
  }

  const mode = params.get('mode')
  if (mode === 'heat' || mode === 'binary') {
    useAppStore.setState({ colorMode: mode })
  }

  const form = params.get('form')
  if (form === 'band' || form === 'curve') {
    useAppStore.setState({ oneDForm: form })
  }

  // 阶段 ⑥：用与界面输入等价的路径应用一份 spec（走 store.applySpec，真实重算判定）
  // 截图用途下先等入场动画结束，避免截到 stagger 只揭示一半的中间帧
  const specParam = params.get('spec')
  if (specParam) {
    try {
      const { parseSpecValue } = await import('@shared/csv/metadata')
      await new Promise<void>((resolve) => setTimeout(resolve, 900))
      useAppStore.getState().applySpec(parseSpecValue(specParam))
      // 等 React + 画布完成一次重绘再继续截图流程
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    } catch (err) {
      console.warn('[demo] spec 参数非法，已忽略', specParam, err)
    }
  }

  // 二值配色已在阶段 ③c 定稿为 A′（青绿 PASS / 正红 FAIL），不再提供版本切换参数

  // 等图表挂载后再做悬停/压测，避免在空态上操作
  await waitFor(() => document.querySelector<HTMLElement>('.shmoo-chart'))

  const hover = params.get('hover')
  if (hover) await applyHover(dataset, hover)

  // 锁定 / 框选演示：也放在切片之前，切片会清空锁定与框选（跨视图重置规则）
  const lock = params.get('lock')
  if (lock) await applyLock(dataset, lock)

  const boxParam = params.get('box')
  if (boxParam) await applyBox(dataset, boxParam)

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

  if (params.get('bench') === '1' && dataset.kind === '2d') {
    const grid = Number.parseInt(params.get('grid') ?? '0', 10)
    runBench(dataset, Number.isFinite(grid) && grid > 0 ? grid : 0)
  }

  // 交互层耗时探针：放在最后，保证前面的演示状态（lock/box/slice）不会干扰测量
  if (params.get('interaction-perf') === '1') {
    await runInteractionProbe(dataset)
  }

  // 阶段 ⑥ spec 重算 + 重绘耗时：读取 store 里的最新 dataset（可能已被 spec 参数改过）
  if (params.get('spec-perf') === '1') {
    const current = useAppStore.getState().dataset ?? dataset
    await runSpecPerfProbe(current)
  }
}
