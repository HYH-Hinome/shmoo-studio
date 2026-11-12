import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import type { Axis, ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS } from '@shared/types/shmoo'
import { DEFAULT_PADDING, cellCenter, cellRect, computeGeometry, hitTest, tickDecimals } from '../chart/geometry'
import type { CellIndex, ChartGeometry } from '../chart/geometry'
import { drawBoundaryLayer, drawInteractionLayer, drawStaticLayer, ENTRANCE_TOTAL } from '../chart/render2d'
import type { ChartColorMode, MotionInput } from '../chart/render2d'
import type { SliceRef } from '../chart/slice'
import { computeMarginTints } from '../chart/colors'
import { isFlatBinaryDataset, isMarginMeaningful, evaluatePoint } from '@shared/spec/evaluate'
import type { ChartPerf } from '../chart/perf'
import { useLayeredCanvas } from '../chart/useLayeredCanvas'
import type { LayerName, LayerRenderer } from '../chart/useLayeredCanvas'
import {
  TOOLTIP_HEIGHT,
  TOOLTIP_WIDTH,
  classifyClick,
  computeTooltipPlacement,
  moveCell,
  normalizeBox,
  rowEdgeCell
} from '../chart/interaction'
import type { ClickRecord } from '../chart/interaction'
import { useAppStore } from '../state/store'
import { formatSigned } from '../lib/format'

/**
 * 2D Shmoo 图表组件。
 *
 * 结构：一个定位容器 + 三层叠放的 canvas（静态 / 边界 / 交互）+ 一个 DOM 浮层。
 *  - 静态层：色块、坐标轴、图例、高亮框 —— 数据/spec/尺寸/配色变化时重绘；
 *  - 边界层：pass/fail 轮廓 —— 只在二值模式绘制；
 *  - 交互层：十字线、hover/锁定描边、框选与涟漪 —— 每帧只清这一层，静止时不产生任何绘制。
 *
 * 阶段 ⑤ 的交互规则：
 *  1. 悬停：十字线贯穿全图，浮层显示坐标 / 状态 / value / margin，靠近边缘自动翻转；
 *  2. 单击锁定：浮层常显、格子加高亮描边，再次单击同一格解除；锁定后鼠标移动不再改读数；
 *  3. 键盘：方向键移格、Home/End 行首行尾、Shift+方向键扩展框选、Esc 解除、
 *     Enter/Space 锁定当前格；容器可聚焦，纯键盘可完成“选格 → 锁定 → 读数 → 解除”；
 *  4. 拖拽框选：按下后移动形成矩形，状态栏显示区域统计；Esc 或再次单击清除；
 *  5. 单击 / 双击区分：同一格 250ms 内的第二次点击才判为双击（切片），
 *     第一次点击的锁定会延迟到判定窗口后再执行，因此不会互相误触发。
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
/** 拖拽判定阈值（px）：小于该距离视为单击，避免手抖把单击变成 1 格框选 */
const DRAG_THRESHOLD = 4

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

  // ---- 锁定 / 框选：低频状态放 store，状态栏也能读到框选统计 ----
  const selection = useAppStore((s) => s.selection)
  const box = useAppStore((s) => s.box)
  const toggleSelection = useAppStore((s) => s.toggleSelection)
  const setSelection = useAppStore((s) => s.setSelection)
  const setBox = useAppStore((s) => s.setBox)
  const clearInteraction = useAppStore((s) => s.clearInteraction)

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

  // 锁定 / 框选也要能被 renderer 同步读到（renderers 是 useMemo 缓存的，不能依赖 state 闭包）
  const selectionRef = useRef<CellIndex | null>(selection)
  const boxRef = useRef(box)
  selectionRef.current = selection
  boxRef.current = box

  // hover 涟漪：起点 + 开始时间；动画进度只放在 ref 里，不触发 React 重渲染
  const rippleRef = useRef<{ x: number; y: number; startedAt: number } | null>(null)
  const rippleRafRef = useRef(0)
  /** 涟漪进度（ms），绘制时读取；null 表示不画 */
  const rippleElapsedRef = useRef<number | null>(null)

  // 拖拽框选：记录起点与“是否已经移动超过阈值”
  const dragRef = useRef<{
    anchor: CellIndex
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  // 单击延迟锁定：给双击判定留出 250ms 窗口
  const clickTimerRef = useRef<number | null>(null)
  const lastClickRef = useRef<ClickRecord | null>(null)

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
        const lockedCell = selectionRef.current
        const boxSel = boxRef.current
        // 锁定优先：锁定后准线与描边固定在锁定格，鼠标移动不再改变显示；
        // 框选期间则完全不显示 hover，避免遮挡正在比较的区域。
        const active = boxSel
          ? null
          : lockedCell ?? (hoverVisibleRef.current ? hoverRef.current : null)
        const origin = rippleRef.current
        const elapsed = rippleElapsedRef.current
        drawInteractionLayer(ctx, size, {
          geometry,
          hover: active,
          // 整行提示只在“未锁定、未框选”的普通悬停时显示
          hoverRow: active && !lockedCell ? active.iy : null,
          // 涟漪：起点与进度都来自 ref，避免逐帧 setState
          ripple: origin && elapsed !== null ? { x: origin.x, y: origin.y, elapsed } : null,
          locked: lockedCell,
          box: boxSel ? normalizeBox(boxSel.anchor, boxSel.focus) : null
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
  }, [dataset.id, site.siteId, mode, reducedMotion, size.width > 0, size.height > 0, repaint])

  // 阶段 ⑥：spec 编辑只改变判定与 margin，不重播入场动画。
  // 用 layout effect 在浏览器绘制前完成重绘，避免“旧图闪一帧”。
  useLayoutEffect(() => {
    if (dataset.revision <= 0) return
    repaint('all')
  }, [dataset.revision, repaint])

  // hover / 锁定 / 框选变化 → 只重绘交互层（静态层与边界层完全不碰）
  useEffect(() => {
    repaint('interaction')
  }, [hover, hoverVisible, selection, box, repaint])

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

  // 卸载时清理涟漪 rAF 与待执行的单击定时器，避免访问已销毁的 canvas / 已切换的视图
  useEffect(() => {
    return () => {
      if (rippleRafRef.current) window.cancelAnimationFrame(rippleRafRef.current)
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
    }
  }, [])

  // 切片标记只在静态层：变化时重绘静态层（返回 2D 后标记要立刻出现）
  useEffect(() => {
    repaint('static')
  }, [sliceMarker, repaint])

  // 切换站点 / 数据集时清空本地 hover（store 负责清空锁定与框选），
  // 避免旧的 hover 索引在新网格里指到别的格子。
  useEffect(() => {
    setHover(null)
    setHoverVisible(false)
    dragRef.current = null
    lastClickRef.current = null
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
  }, [site.siteId, dataset.id])

  // 开发模式下把耗时采样挂到 window，供浏览器自动化实测读取（生产构建不执行）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__shmooPerf = perfRef.current
  }, [])

  // ---- 指针交互 ----
  const nx = xAxis.values.length
  const ny = yAxis.values.length

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

  /** 取消尚未执行的单击锁定（双击到达或视图切换时调用） */
  const cancelPendingLock = (): void => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 只处理左键；右键与中键不参与读数
    if (event.button !== 0) return
    // 让容器拿到焦点，点击之后可以直接用键盘继续移动 / 锁定
    containerRef.current?.focus({ preventScroll: true })
    const cell = cellFromPoint(event.clientX, event.clientY)
    if (!cell) return

    // 开始新拖拽：先清掉旧框选，避免“新增框选”与旧区域混在一起
    if (boxRef.current) setBox(null)
    dragRef.current = {
      anchor: cell,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag) {
      const moved =
        drag.moved ||
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= DRAG_THRESHOLD
      if (!moved) return
      const cell = cellFromPoint(event.clientX, event.clientY)
      if (!cell) return
      if (!drag.moved) {
        // 第一次真正拖出框：解除旧的锁定，避免锁定描边与框选混在一起
        setSelection(null)
      }
      drag.moved = true
      // 框选期间不显示 hover 浮层，避免浮层盖住正在比较的区域
      if (hoverVisible) setHoverVisible(false)
      setBox({ anchor: drag.anchor, focus: cell })
      return
    }

    // 已有框选或已锁定：鼠标移动不改变读数，直接返回（也避免无意义重绘）
    if (boxRef.current || selectionRef.current) {
      if (hoverVisible) setHoverVisible(false)
      return
    }

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

  const handlePointerUp = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return

    // 拖出了矩形：保留框选，不触发单击锁定
    if (drag.moved) {
      cancelPendingLock()
      lastClickRef.current = null
      return
    }

    // 未移动 = 一次单击。先判断是否属于双击（250ms 内的同格第二次点击）。
    const now = performance.now()
    const verdict = classifyClick(lastClickRef.current, drag.anchor, now)
    if (verdict === 'double') {
      // 双击：取消第一次点击排队中的锁定，直接进入切片。
      // 这样“单击锁定”与“双击切片”不会互相误触发。
      cancelPendingLock()
      lastClickRef.current = null
      onSlice?.({ axis: 'row', index: drag.anchor.iy })
      return
    }

    lastClickRef.current = { cell: drag.anchor, time: now }
    // 延迟 250ms 执行锁定切换：窗口内若来了第二次点击，会在上面被取消
    cancelPendingLock()
    const target = drag.anchor
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      toggleSelection(target)
    }, 250)
  }

  const handlePointerLeave = (): void => {
    dragRef.current = null
    if (!selectionRef.current) setHoverVisible(false)
  }

  /**
   * 键盘导航。
   * 基础格 = 锁定格 → 当前 hover → 网格中心；
   * Shift+方向键只在已有锁定格时生效（从锁定格作为锚点扩展框选）。
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (nx <= 0 || ny <= 0) return

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelPendingLock()
      lastClickRef.current = null
      clearInteraction()
      setHoverVisible(false)
      return
    }

    const base =
      selection ?? hover ?? { ix: Math.floor((nx - 1) / 2), iy: Math.floor((ny - 1) / 2) }
    const isArrow =
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown'
    const isEdge = event.key === 'Home' || event.key === 'End'

    if (isArrow || isEdge) {
      event.preventDefault()
      const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      // 几何约定“行 0 在底部”：上箭头 = iy + 1，下箭头 = iy - 1
      const dy = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
      const next = isEdge
        ? rowEdgeCell(base, event.key === 'Home' ? 'start' : 'end', nx)
        : moveCell(base, dx, dy, nx, ny)

      if (event.shiftKey) {
        // Shift：以锁定格为锚点扩展框选；没有锁定格时先执行普通移动
        if (selection) {
          setBox({ anchor: selection, focus: next })
          setHoverVisible(false)
        }
        return
      }

      if (selection) {
        // 已锁定：方向键移动锁定目标，浮层跟着走（保持常显）
        setSelection(next)
      } else {
        setHover(next)
        setHoverVisible(true)
      }
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      // 纯键盘锁定 / 解除：与单击同一个入口，保证语义一致
      event.preventDefault()
      toggleSelection(base)
      setHoverVisible(false)
    }
  }

  // ---- 浮层读数与定位 ----
  // 锁定后以锁定格为准：鼠标移动不再改变读数（“腾出手记数据”）
  const safeSelection =
    selection && selection.ix >= 0 && selection.ix < nx && selection.iy >= 0 && selection.iy < ny
      ? selection
      : null
  const boxActive = box !== null
  const displayCell = boxActive ? null : safeSelection ?? (hoverVisible ? hover : null)
  const tipVisible = displayCell !== null

  const displayIndex = displayCell ? displayCell.iy * nx + displayCell.ix : -1
  const displayValue = displayCell && displayIndex >= 0 ? site.value[displayIndex] : Number.NaN
  const displayState = displayCell && displayIndex >= 0 ? site.pass[displayIndex] : null

  const stateLabel =
    displayState === CELL_PASS ? 'PASS' : displayState === CELL_FAIL ? 'FAIL' : 'NO DATA'
  const stateClass =
    displayState === CELL_PASS ? 'pass' : displayState === CELL_FAIL ? 'fail' : 'unknown'

  const xDecimals = useMemo(() => tickDecimals(xAxis.values), [xAxis.values])
  const yDecimals = useMemo(() => tickDecimals(yAxis.values), [yAxis.values])

  // margin 文案：二值 / 零宽窗口数据只显示“不适用”，不输出假数字
  const marginText = useMemo(() => {
    if (!displayCell) return '不适用'
    if (!isMarginMeaningful(dataset)) return '不适用'
    if (!Number.isFinite(displayValue)) return '—'
    const { margin } = evaluatePoint(displayValue, dataset.spec)
    if (margin === null || !Number.isFinite(margin)) return '—'
    const unit = dataset.valueUnit ? ` ${dataset.valueUnit}` : ''
    return `${formatSigned(margin)}${unit}`
  }, [displayCell, dataset, displayValue])

  const tooltipStyle = useMemo<CSSProperties>(() => {
    if (!displayCell) return { display: 'none' }
    // 浮层避让：靠近右/下边缘时自动翻到另一侧，并夹在容器内（几何规则见 interaction.ts）
    const placement = computeTooltipPlacement(
      cellRect(geometry, displayCell.ix, displayCell.iy),
      { width: size.width, height: size.height },
      { width: TOOLTIP_WIDTH, height: TOOLTIP_HEIGHT }
    )
    return { left: placement.left, top: placement.top }
  }, [displayCell, geometry, size.width, size.height])

  return (
    <div
      className="shmoo-chart"
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label={`2D Shmoo 图表交互区：方向键移动，Enter 锁定，Esc 解除`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
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

      {displayCell ? (
        <div
          className={`chart-tip${tipVisible ? ' is-visible' : ''}${safeSelection ? ' is-locked' : ''}`}
          style={tooltipStyle}
          aria-hidden={!tipVisible}
          data-chart-tip="1"
        >
          <div className="chart-tip__head">
            <span className="chart-tip__site">{site.siteLabel}</span>
            <span className={`chart-tip__state chart-tip__state--${stateClass}`}>{stateLabel}</span>
          </div>
          <dl>
            <div>
              <dt>{xAxis.label}</dt>
              <dd className="mono">
                {xAxis.values[displayCell.ix].toFixed(xDecimals)}
                {xAxis.unit ? <i> {xAxis.unit}</i> : null}
              </dd>
            </div>
            <div>
              <dt>{yAxis.label}</dt>
              <dd className="mono">
                {yAxis.values[displayCell.iy].toFixed(yDecimals)}
                {yAxis.unit ? <i> {yAxis.unit}</i> : null}
              </dd>
            </div>
            <div>
              <dt>{dataset.valueLabel}</dt>
              <dd className="mono">
                {formatMeasure(displayValue, site.valueRange)}
                {dataset.valueUnit ? <i> {dataset.valueUnit}</i> : null}
              </dd>
            </div>
            <div>
              <dt>margin</dt>
              <dd className="mono">{marginText}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  )
}
