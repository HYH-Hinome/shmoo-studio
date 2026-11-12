import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Axis, ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS } from '@shared/types/shmoo'
import { DEFAULT_PADDING, cellCenter, computeGeometry, hitTest, tickDecimals } from '../chart/geometry'
import type { CellIndex, ChartGeometry } from '../chart/geometry'
import { drawBoundaryLayer, drawInteractionLayer, drawStaticLayer, ENTRANCE_TOTAL } from '../chart/render2d'
import type { ChartColorMode, MotionInput } from '../chart/render2d'
import type { SliceRef } from '../chart/slice'
import { computeMarginTints } from '../chart/colors'
import { isFlatBinaryDataset } from '@shared/spec/evaluate'
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

/**
 * 入场动画总时长由 render2d 的 ENTRANCE_TOTAL 决定（6 层 × 30ms + 240ms ≈ 390ms），
 * 这里多留 60ms 作为收尾余量，避免最后一层的淡入被截断。
 */
const ENTRANCE_SETTLE = ENTRANCE_TOTAL + 60
/** hover 涟漪时长（ms），与 render2d 的 RIPPLE_DURATION 保持一致 */
const RIPPLE_MS = 300
/** 氛围动效目标帧率：约 20fps，靠跳帧实现，不做全量逐帧重绘 */
const AMBIENT_FRAME_MS = 50
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
  /** 氛围动效开关（默认关） */
  ambientMotion?: boolean
  /** 切片标记（返回 2D 后仍保留），null 表示没有 */
  sliceMarker?: SliceRef | null
  /** 双击某格时触发：切出该格所在的行（列可通过切片视图内的标签切换） */
  onSlice?: (ref: SliceRef) => void
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

export function Shmoo2DChart({
  dataset,
  site,
  xAxis,
  yAxis,
  mode,
  ambientMotion = false,
  sliceMarker = null,
  onSlice
}: Shmoo2DChartProps): JSX.Element {
  const reducedMotion = useReducedMotion()

  // ---- 绘制阶段需要的最新状态（用 ref 保存，renderers 只依赖 ref，不会因 state 变化重建） ----
  const geometryRef = useRef<ChartGeometry | null>(null)
  const motionRef = useRef<MotionInput>({ enabled: false, elapsed: 0 })
  const modeRef = useRef<ChartColorMode>(mode)
  modeRef.current = mode
  /** 氛围动效相位：只在 rAF 循环里推进，不进 React state */
  const ambientRef = useRef<{ phase: number; drift: number } | null>(null)
  const perfRef = useRef<ChartPerf>({ static: [], boundary: [], interaction: [], frames: 0 })

  // hover 只影响交互层与 DOM 浮层；绘制时通过 ref 读取，避免高频 state → 重绘调度链路
  const [hover, setHover] = useState<HoverCell | null>(null)
  const [hoverVisible, setHoverVisible] = useState(false)
  const hoverRef = useRef<HoverCell | null>(hover)
  const hoverVisibleRef = useRef(hoverVisible)
  hoverRef.current = hover
  hoverVisibleRef.current = hoverVisible

  // hover 涟漪：起点 + 开始时间；动画进度只放在 ref 里，不触发 React 重渲染
  const rippleRef = useRef<{ x: number; y: number; startedAt: number } | null>(null)
  const rippleRafRef = useRef(0)
  /** 涟漪进度（ms），绘制时读取；null 表示不画 */
  const rippleElapsedRef = useRef<number | null>(null)

  const recordTiming = useCallback((key: 'static' | 'boundary' | 'interaction', ms: number) => {
    pushSample(perfRef.current[key], ms)
  }, [])

  // ---- margin 明度调制数据 ----
  // 每个格子的 |margin| 归一化到 0–1；spec / 数据 / 站点变化时重算一次。
  // 900 个点的计算量远小于一帧预算，因此不需要放进 Worker。
  const marginTints = useMemo(
    () => computeMarginTints(site, dataset.spec),
    [site, dataset.spec, dataset.revision]
  )

  // 纯二值数据集（0/1 pattern 或无 value 列）：整片饱和平涂，不做 margin 明度调制。
  // 在这里算一次，renderers 与图例都读同一个布尔值，避免逐格判断。
  const flatBinary = useMemo(() => isFlatBinaryDataset(dataset), [dataset])

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
      // 数据集级配色分支：连续值走 margin 明度，纯二值走饱和平涂（useMemo 一次判定）
      flatBinary,
      tint: marginTints
    }

    return {
      static: (ctx, size) => {
        const geometry = geometryRef.current
        if (!geometry) return
        const startedAt = performance.now()
        drawStaticLayer(ctx, size, {
          ...dataInput,
          geometry,
          mode: modeRef.current,
          motion: motionRef.current,
          sliceMarker
        })
        perfRef.current.frames += 1
        recordTiming('static', performance.now() - startedAt)
      },
      boundary: (ctx, size) => {
        const geometry = geometryRef.current
        if (!geometry) return
        const startedAt = performance.now()
        drawBoundaryLayer(
          ctx,
          size,
          {
            ...dataInput,
            geometry,
            mode: modeRef.current,
            motion: motionRef.current
          },
          // 氛围动效默认关闭：只有开关打开时才有相位对象
          ambientRef.current
        )
        recordTiming('boundary', performance.now() - startedAt)
      },
      interaction: (ctx, size) => {
        const geometry = geometryRef.current
        if (!geometry) return
        const startedAt = performance.now()
        const active = hoverVisibleRef.current ? hoverRef.current : null
        const origin = rippleRef.current
        const elapsed = rippleElapsedRef.current
        drawInteractionLayer(ctx, size, {
          geometry,
          hover: active,
          // 悬停整行提示：只依赖当前格子的行号，hover 变化时重绘这一层即可
          hoverRow: active ? active.iy : null,
          // 涟漪：起点与进度都来自 ref，避免逐帧 setState
          ripple:
            origin && elapsed !== null
              ? { x: origin.x, y: origin.y, elapsed }
              : null
        })
        recordTiming('interaction', performance.now() - startedAt)
      }
    }
  }, [dataset.valueLabel, dataset.valueUnit, flatBinary, site, xAxis, yAxis, recordTiming, marginTints, sliceMarker])

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
      motionRef.current = { enabled: false, elapsed: 0 }
      repaint('all')
      return
    }

    const startedAt = performance.now()
    let raf = 0

    const tick = (now: number): void => {
      const elapsed = now - startedAt
      motionRef.current = { enabled: true, elapsed }
      repaint('static')
      repaint('boundary')

      if (elapsed < ENTRANCE_SETTLE) {
        raf = window.requestAnimationFrame(tick)
      } else {
        // 收尾：关闭动画后整层重绘一次，确保所有色块都是不透明状态
        motionRef.current = { enabled: false, elapsed: 0 }
        repaint('all')
      }
    }

    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
    // 尺寸从 0 变为有效值时也要启动；真正改变宽高不重新播放入场动画
  }, [dataset.id, dataset.revision, site.siteId, mode, reducedMotion, size.width > 0, size.height > 0, repaint])

  // hover 变化 → 只重绘交互层
  useEffect(() => {
    repaint('interaction')
  }, [hover, hoverVisible, repaint])

  // 氛围动效：默认关闭。开启后用 rAF 推进相位，但只重绘边界层（≈20fps），
  // 静态色块层保持不动；关闭时立即停止循环并清掉相位，画面回到完全静止。
  useEffect(() => {
    if (!ambientMotion || reducedMotion || mode !== 'binary') {
      ambientRef.current = null
      repaint('boundary')
      return
    }

    const startedAt = performance.now()
    let lastPaint = 0
    let raf = 0

    const tick = (now: number): void => {
      // 跳帧到约 20fps：氛围动效是慢速呼吸，没有必要跑满 60fps
      if (now - lastPaint >= AMBIENT_FRAME_MS) {
        lastPaint = now
        const seconds = (now - startedAt) / 1000
        ambientRef.current = {
          // 4s 一个呼吸周期
          phase: (seconds / 4) * Math.PI * 2,
          // 噪声纹理缓慢平移（96px 平铺，取模避免数值过大）
          drift: (seconds * 8) % 96
        }
        repaint('boundary')
      }
      raf = window.requestAnimationFrame(tick)
    }

    raf = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(raf)
      ambientRef.current = null
    }
  }, [ambientMotion, reducedMotion, mode, repaint])

  // 字体就绪后重绘：JetBrains Mono 是本地打包字体，首帧可能还没加载完，
  // 若不重绘会出现“第一次进来刻度是回退字体、切一次站点才变”的问题。
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return
    let cancelled = false
    void document.fonts
      .load('10px "JetBrains Mono"')
      .then(() => {
        if (!cancelled) repaint('all')
      })
      .catch(() => {
        // 字体加载失败不阻塞图表：继续用等宽回退字体
      })
    return () => {
      cancelled = true
    }
  }, [repaint])

  // 卸载时清理涟漪 rAF，避免访问已销毁的 canvas
  useEffect(() => {
    return () => {
      if (rippleRafRef.current) window.cancelAnimationFrame(rippleRafRef.current)
    }
  }, [])

  // 切片标记只在静态层：变化时重绘静态层（返回 2D 后标记要立刻出现）
  useEffect(() => {
    repaint('static')
  }, [sliceMarker, repaint])

  // 开发模式下把耗时采样挂到 window，供浏览器自动化实测读取（生产构建不执行）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__shmooPerf = perfRef.current
  }, [])

  // ---- 指针交互 ----
  /**
   * 把鼠标坐标换算成格子索引。
   * getBoundingClientRect 含边框，clientLeft/clientTop 是边框宽度，需要减掉才是画布内坐标。
   */
  const cellFromPoint = (clientX: number, clientY: number): CellIndex | null => {
    const container = containerRef.current
    if (!container || size.width < 2) return null
    const rect = container.getBoundingClientRect()
    const px = clientX - rect.left - container.clientLeft
    const py = clientY - rect.top - container.clientTop
    return hitTest(geometry, px, py)
  }

  /**
   * 从命中点扩散涟漪。
   * 动画全程只重绘交互层，且 300ms 后自动停下；reduced-motion 下直接不启动。
   */
  const startRipple = useCallback(
    (x: number, y: number): void => {
      if (reducedMotion) return
      rippleRef.current = { x, y, startedAt: performance.now() }
      rippleElapsedRef.current = 0
      // 已有循环在跑时只重置起点，不叠加新的 rAF
      if (rippleRafRef.current) return

      const tick = (now: number): void => {
        const origin = rippleRef.current
        if (!origin) {
          rippleRafRef.current = 0
          return
        }
        const elapsed = now - origin.startedAt
        rippleElapsedRef.current = Math.min(elapsed, RIPPLE_MS)
        repaint('interaction')

        if (elapsed < RIPPLE_MS) {
          rippleRafRef.current = window.requestAnimationFrame(tick)
        } else {
          // 结束后清掉进度，交互层再画一次就没有涟漪残留
          rippleRafRef.current = 0
          rippleElapsedRef.current = null
          repaint('interaction')
        }
      }
      rippleRafRef.current = window.requestAnimationFrame(tick)
    },
    [reducedMotion, repaint]
  )

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const cell = cellFromPoint(event.clientX, event.clientY)
    if (!cell) {
      // 指针在轴/图例/留白上：隐藏十字线与浮层，但不立即清空 hover 数据（浮层需要淡出）
      if (hoverVisible) setHoverVisible(false)
      return
    }

    if (!hover || hover.ix !== cell.ix || hover.iy !== cell.iy) {
      setHover(cell)
      // 每次进入新的格子才扩散一次，同一格内移动不重复触发
      const center = cellCenter(geometry, cell.ix, cell.iy)
      startRipple(center.x, center.y)
    }
    if (!hoverVisible) setHoverVisible(true)
  }

  /**
   * 双击切片。
   *
   * 事件顺序说明：阶段 ⑤ 会加入“单击锁定”，届时单击处理需要延迟到双击判定窗口之后
   * （约 250ms）再执行；这里不注册 onClick，因此不会吞掉双击，也无需 preventDefault。
   * 用原生 dblclick 而不是自己数两次 pointerdown，触摸板轻点与高 DPI 屏都能稳定触发。
   */
  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!onSlice) return
    const cell = cellFromPoint(event.clientX, event.clientY)
    if (!cell) return
    // 默认切“行”（固定 y 扫 x）；列方向在切片视图里用标签切换
    onSlice({ axis: 'row', index: cell.iy })
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
      onDoubleClick={handleDoubleClick}
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
