import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { Axis, ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS } from '@shared/types/shmoo'
import { DEFAULT_PADDING, cellCenter, computeGeometry, hitTest, tickDecimals } from '../chart/geometry'
import type { CellIndex, ChartGeometry } from '../chart/geometry'
import { drawBoundaryLayer, drawInteractionLayer, drawStaticLayer } from '../chart/render2d'
import type { ChartColorMode, MotionInput } from '../chart/render2d'
import { computeMarginTints } from '../chart/colors'
import type { PaletteVariant } from '../chart/colors'
import type { ChartPerf } from '../chart/perf'
import { useLayeredCanvas } from '../chart/useLayeredCanvas'
import type { LayerName, LayerRenderer } from '../chart/useLayeredCanvas'

/**
 * 2D Shmoo 图表组件。
 *
 * 结构：一个定位容器 + 三层叠放的 canvas（静态 / 边界 / 交互）+ 一个 DOM 浮层。
 *  - 静态层：色块、坐标轴、图例、高亮框 —— 数据/spec/尺寸/配色变化时重绘；
 *  - 边界层：pass/fail 轮廓 —— 只在二值模式绘制；
 *  - 交互层：十字线与 hover 格描边 —— 每帧只清这一层，静止时不产生任何绘制。
 *
 * 入场动画只用 rAF 驱动 canvas，动画状态不进 React state，
 * 因此不会因为逐帧 setState 触发组件树重渲染。
 */

/** 入场动画：色块对角线渐显的总延迟跨度（ms） */
const ENTRANCE_DELAY_SPAN = 260
/** 入场动画：单个色块的淡入时长（ms） */
const ENTRANCE_CELL_DURATION = 240
/** hover 浮层与格中心的间距（px） */
const TOOLTIP_OFFSET = 14
/** hover 浮层尺寸估算，用于判断是否翻转方向（与 CSS 中宽度一致） */
const TOOLTIP_WIDTH = 178
const TOOLTIP_HEIGHT = 104

interface Shmoo2DChartProps {
  dataset: ShmooDataset
  site: SiteGrid
  xAxis: Axis
  yAxis: Axis
  mode: ChartColorMode
  /** 配色版本 A / B（阶段 ③b 提供两版供选择） */
  variant: PaletteVariant
}

/** 当前悬停的格子（只保存索引，像素位置由几何实时算出） */
type HoverCell = CellIndex

/**
 * 是否开启了“减少动效”系统偏好。
 * jsdom / 测试环境没有 matchMedia，此时按“无动效”处理，避免抛错。
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/** 把耗时压入采样数组，限制长度避免长时间运行内存增长 */
function pushSample(list: number[], ms: number): void {
  list.push(ms)
  if (list.length > 240) list.shift()
}

/** 单元格读数格式化：至少 2 位、最多 4 位小数，保证不同量级下都可读 */
function formatMeasure(value: number, range: { min: number; max: number } | null): string {
  if (!Number.isFinite(value)) return '—'
  const decimals = range ? Math.max(2, Math.min(4, tickDecimals([range.min, range.max]) + 1)) : 3
  return value.toFixed(decimals)
}

export function Shmoo2DChart({ dataset, site, xAxis, yAxis, mode, variant }: Shmoo2DChartProps): JSX.Element {
  const reducedMotion = useReducedMotion()

  // ---- 绘制阶段需要的最新状态（用 ref 保存，renderers 只依赖 ref，不会因 state 变化重建） ----
  const geometryRef = useRef<ChartGeometry | null>(null)
  const motionRef = useRef<MotionInput>({ enabled: false, delaySpan: 0, cellDuration: 0, elapsed: 0 })
  const modeRef = useRef<ChartColorMode>(mode)
  modeRef.current = mode
  const perfRef = useRef<ChartPerf>({ static: [], boundary: [], interaction: [], frames: 0 })

  // hover 只影响交互层与 DOM 浮层；绘制时通过 ref 读取，避免高频 state → 重绘调度链路
  const [hover, setHover] = useState<HoverCell | null>(null)
  const [hoverVisible, setHoverVisible] = useState(false)
  const hoverRef = useRef<HoverCell | null>(hover)
  const hoverVisibleRef = useRef(hoverVisible)
  hoverRef.current = hover
  hoverVisibleRef.current = hoverVisible

  const recordTiming = useCallback((key: 'static' | 'boundary' | 'interaction', ms: number) => {
    pushSample(perfRef.current[key], ms)
  }, [])

  // ---- margin 明度调制数据（A 版使用） ----
  // 每个格子的 |margin| 归一化到 0–1；spec / 数据 / 站点变化时重算一次。
  // 900 个点的计算量远小于一帧预算，因此不需要放进 Worker。
  const marginTints = useMemo(
    () => computeMarginTints(site, dataset.spec),
    [site, dataset.spec, dataset.revision]
  )

  // ---- 三层绘制函数 ----
  // 注意：只依赖数据与轴（以及绘制时不会变化的常量），
  // hover / 动画进度 / 配色模式都通过 ref 读取，避免重建 renderers。
  const renderers = useMemo<Record<LayerName, LayerRenderer>>(() => {
    const dataInput = {
      xAxis,
      yAxis,
      site,
      valueLabel: dataset.valueLabel,
      valueUnit: dataset.valueUnit,
      variant,
      tint: marginTints
    }

    return {
      static: (ctx, size) => {
        const geometry = geometryRef.current
        if (!geometry) return
        const startedAt = performance.now()
        drawStaticLayer(ctx, size, { ...dataInput, geometry, mode: modeRef.current, motion: motionRef.current })
        perfRef.current.frames += 1
        recordTiming('static', performance.now() - startedAt)
      },
      boundary: (ctx, size) => {
        const geometry = geometryRef.current
        if (!geometry) return
        const startedAt = performance.now()
        drawBoundaryLayer(ctx, size, {
          ...dataInput,
          geometry,
          mode: modeRef.current,
          motion: motionRef.current
        })
        recordTiming('boundary', performance.now() - startedAt)
      },
      interaction: (ctx, size) => {
        const geometry = geometryRef.current
        if (!geometry) return
        const startedAt = performance.now()
        drawInteractionLayer(ctx, size, {
          geometry,
          hover: hoverVisibleRef.current ? hoverRef.current : null
        })
        recordTiming('interaction', performance.now() - startedAt)
      }
    }
  }, [dataset.valueLabel, dataset.valueUnit, site, xAxis, yAxis, recordTiming, variant, marginTints])

  const { containerRef, canvasRefs, size, repaint } = useLayeredCanvas(renderers)

  // 几何：每次尺寸变化重算一次；绘制时通过 ref 取最新值
  const geometry = useMemo(
    () => computeGeometry(size.width, size.height, DEFAULT_PADDING, xAxis.values, yAxis.values),
    [size.width, size.height, xAxis, yAxis]
  )
  geometryRef.current = geometry

  // ---- 入场动画：数据 / 站点 / 配色切换时重新播放 ----
  useEffect(() => {
    if (size.width < 2 || size.height < 2) return

    // 尊重 prefers-reduced-motion：开启时瞬显，不跑任何动画帧
    if (reducedMotion) {
      motionRef.current = { enabled: false, delaySpan: 0, cellDuration: 0, elapsed: 0 }
      repaint('all')
      return
    }

    const startedAt = performance.now()
    let raf = 0

    const tick = (now: number): void => {
      const elapsed = now - startedAt
      motionRef.current = {
        enabled: true,
        delaySpan: ENTRANCE_DELAY_SPAN,
        cellDuration: ENTRANCE_CELL_DURATION,
        elapsed
      }
      repaint('static')
      repaint('boundary')

      if (elapsed < ENTRANCE_DELAY_SPAN + ENTRANCE_CELL_DURATION) {
        raf = window.requestAnimationFrame(tick)
      } else {
        // 收尾：关闭动画后整层重绘一次，确保所有色块都是不透明状态
        motionRef.current = { enabled: false, delaySpan: 0, cellDuration: 0, elapsed: 0 }
        repaint('all')
      }
    }

    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
    // 尺寸从 0 变为有效值时也要启动；真正改变宽高不重新播放入场动画
  }, [dataset.id, dataset.revision, site.siteId, mode, variant, reducedMotion, size.width > 0, size.height > 0, repaint])

  // hover 变化 → 只重绘交互层
  useEffect(() => {
    repaint('interaction')
  }, [hover, hoverVisible, repaint])

  // 开发模式下把耗时采样挂到 window，供浏览器自动化实测读取（生产构建不执行）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__shmooPerf = perfRef.current
  }, [])

  // ---- 指针交互 ----
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const container = containerRef.current
    if (!container || size.width < 2) return

    // getBoundingClientRect 含边框，clientLeft/clientTop 是边框宽度，需要减掉才能得到画布内坐标
    const rect = container.getBoundingClientRect()
    const px = event.clientX - rect.left - container.clientLeft
    const py = event.clientY - rect.top - container.clientTop
    const cell = hitTest(geometry, px, py)

    if (!cell) {
      // 指针在轴/图例/留白上：隐藏十字线与浮层，但不立即清空 hover 数据（浮层需要淡出）
      if (hoverVisible) setHoverVisible(false)
      return
    }

    if (!hover || hover.ix !== cell.ix || hover.iy !== cell.iy) setHover(cell)
    if (!hoverVisible) setHoverVisible(true)
  }

  const handlePointerLeave = (): void => {
    setHoverVisible(false)
  }

  // ---- hover 读数与浮层定位 ----
  const nx = xAxis.values.length
  const hoverIndex = hover ? hover.iy * nx + hover.ix : -1
  const hoverValue = hover && hoverIndex >= 0 ? site.value[hoverIndex] : Number.NaN
  const hoverState = hover && hoverIndex >= 0 ? site.pass[hoverIndex] : null

  const stateLabel =
    hoverState === CELL_PASS ? 'PASS' : hoverState === CELL_FAIL ? 'FAIL' : 'NO DATA'
  const stateClass =
    hoverState === CELL_PASS ? 'pass' : hoverState === CELL_FAIL ? 'fail' : 'unknown'

  const xDecimals = useMemo(() => tickDecimals(xAxis.values), [xAxis.values])
  const yDecimals = useMemo(() => tickDecimals(yAxis.values), [yAxis.values])

  const tooltipStyle = useMemo<CSSProperties>(() => {
    if (!hover) return { display: 'none' }
    const center = cellCenter(geometry, hover.ix, hover.iy)
    // 靠近右/下边缘时翻转到格子的另一侧，保证浮层始终在容器内
    const flipX = center.x + TOOLTIP_OFFSET + TOOLTIP_WIDTH > size.width
    const flipY = center.y + TOOLTIP_OFFSET + TOOLTIP_HEIGHT > size.height
    return {
      left: Math.round(center.x + (flipX ? -TOOLTIP_OFFSET : TOOLTIP_OFFSET)),
      top: Math.round(center.y + (flipY ? -TOOLTIP_OFFSET : TOOLTIP_OFFSET)),
      transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`
    }
  }, [hover, geometry, size.width, size.height])

  return (
    <div
      className="shmoo-chart"
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      data-chart-root="1"
    >
      <canvas ref={canvasRefs.static} className="shmoo-chart__canvas" aria-hidden="true" />
      <canvas ref={canvasRefs.boundary} className="shmoo-chart__canvas" aria-hidden="true" />
      <canvas
        ref={canvasRefs.interaction}
        className="shmoo-chart__canvas shmoo-chart__canvas--interaction"
        data-chart-canvas="1"
        aria-label={`2D Shmoo 图：${dataset.title}`}
        role="img"
      />

      {hover ? (
        <div
          className={`chart-tip${hoverVisible ? ' is-visible' : ''}`}
          style={tooltipStyle}
          aria-hidden={!hoverVisible}
        >
          <div className="chart-tip__head">
            <span className="chart-tip__site">{site.siteLabel}</span>
            <span className={`chart-tip__state chart-tip__state--${stateClass}`}>{stateLabel}</span>
          </div>
          <dl>
            <div>
              <dt>{xAxis.label}</dt>
              <dd className="mono">
                {xAxis.values[hover.ix].toFixed(xDecimals)}
                {xAxis.unit ? <i> {xAxis.unit}</i> : null}
              </dd>
            </div>
            <div>
              <dt>{yAxis.label}</dt>
              <dd className="mono">
                {yAxis.values[hover.iy].toFixed(yDecimals)}
                {yAxis.unit ? <i> {yAxis.unit}</i> : null}
              </dd>
            </div>
            <div>
              <dt>{dataset.valueLabel}</dt>
              <dd className="mono">
                {formatMeasure(hoverValue, site.valueRange)}
                {dataset.valueUnit ? <i> {dataset.valueUnit}</i> : null}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  )
}
