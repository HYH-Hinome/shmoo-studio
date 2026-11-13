import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { CanvasSize } from './render2d'

/**
 * 三层画布 Hook（对应执行计划 2.2 节的 static / boundary / interaction 三层）。
 *
 * 职责划分：
 *  - 尺寸：ResizeObserver 观测容器，DPR 变化通过 window resize 兜底；
 *  - 后备像素：按 DPR 取整设置 canvas.width/height，CSS 尺寸始终 100%；
 *  - 调度：同一帧内的多次 repaint 合并为一次 rAF，避免重复绘制；
 *  - 隔离：每层单独标记脏状态，交互层每帧只清自己，不触碰静态层与边界层。
 *
 * 这里只做“什么时候画、画多大”，具体画什么由调用方传入的 renderers 决定，
 * 这样几何计算/配色逻辑仍保持纯函数，便于单元测试。
 */

/** 三层名称 */
export type LayerName = 'static' | 'boundary' | 'interaction'

/** 单层绘制函数：调用方负责内容，Hook 负责尺寸、DPR 与清屏时机 */
export type LayerRenderer = (ctx: CanvasRenderingContext2D, size: CanvasSize) => void

export interface UseLayeredCanvasResult {
  /** 容器（用于测量尺寸，也是指针事件的挂载点） */
  containerRef: RefObject<HTMLDivElement>
  /** 三层 canvas 的 ref */
  canvasRefs: Record<LayerName, RefObject<HTMLCanvasElement>>
  /** 当前 CSS 尺寸与 DPR（未测量完成时 width/height 为 0） */
  size: CanvasSize
  /** 请求重绘：默认三层全画，也可只画某一层（同一帧内自动合并） */
  repaint: (layer?: LayerName | 'all') => void
}

/** 读取 DPR：按文档要求取整，避免小数 DPR 下相邻色块出现 1px 缝隙 */
function readDpr(): number {
  const raw = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  return Math.max(1, Math.round(raw))
}

export function useLayeredCanvas(
  renderers: Record<LayerName, LayerRenderer>
): UseLayeredCanvasResult {
  const containerRef = useRef<HTMLDivElement>(null)
  const staticRef = useRef<HTMLCanvasElement>(null)
  const boundaryRef = useRef<HTMLCanvasElement>(null)
  const interactionRef = useRef<HTMLCanvasElement>(null)

  // 绘制函数放进 ref：每次渲染更新最新闭包，但更新本身不触发重绘调度
  const renderersRef = useRef(renderers)
  renderersRef.current = renderers

  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0, dpr: 1 })
  const sizeRef = useRef(size)
  const dirtyRef = useRef<Record<LayerName, boolean>>({
    static: true,
    boundary: true,
    interaction: true
  })
  const frameRef = useRef<number | null>(null)

  /** 立即绘制某一层（内部使用：只在 rAF 回调里调用） */
  const paint = useCallback((layer: LayerName) => {
    const canvas =
      layer === 'static'
        ? staticRef.current
        : layer === 'boundary'
          ? boundaryRef.current
          : interactionRef.current
    if (!canvas) return

    const current = sizeRef.current
    if (current.width < 2 || current.height < 2) return

    // 后备像素 = CSS 尺寸 × DPR；修改 width/height 会清空画布，
    // 所以只在尺寸真正变化时修改，并且紧接着就在本帧内重绘。
    const backingWidth = Math.max(1, Math.round(current.width * current.dpr))
    const backingHeight = Math.max(1, Math.round(current.height * current.dpr))
    if (canvas.width !== backingWidth) canvas.width = backingWidth
    if (canvas.height !== backingHeight) canvas.height = backingHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    renderersRef.current[layer](ctx, current)
  }, [])

  /** rAF 回调：按脏标记依次绘制 */
  const flush = useCallback(() => {
    frameRef.current = null
    const dirty = dirtyRef.current
    if (dirty.static) {
      dirty.static = false
      paint('static')
    }
    if (dirty.boundary) {
      dirty.boundary = false
      paint('boundary')
    }
    if (dirty.interaction) {
      dirty.interaction = false
      paint('interaction')
    }
  }, [paint])

  const repaint = useCallback(
    (layer: LayerName | 'all' = 'all') => {
      if (layer === 'all') {
        dirtyRef.current.static = true
        dirtyRef.current.boundary = true
        dirtyRef.current.interaction = true
      } else {
        dirtyRef.current[layer] = true
      }
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(flush)
      }
    },
    [flush]
  )

  // 尺寸与 DPR 监听
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const measure = (): void => {
      // 用 clientWidth/clientHeight 而不是 getBoundingClientRect：
      // 前者是内容盒尺寸（不含 1px 边框），与 canvas 的 CSS 尺寸严格一致，
      // 否则会出现 Canvas 后备像素比显示尺寸大 2px、整图被轻微拉伸的问题。
      const width = container.clientWidth
      const height = container.clientHeight
      const dpr = readDpr()
      // 取整到 CSS 像素：避免子像素尺寸导致色块宽度不稳定
      const next: CanvasSize = { width, height, dpr }
      const prev = sizeRef.current
      if (prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr) {
        return
      }
      sizeRef.current = next
      setSize(next)
      repaint('all')
    }

    measure()

    // jsdom 等测试环境没有 ResizeObserver：退化为只在窗口 resize 时测量
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(container)
    window.addEventListener('resize', measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [repaint])

  // 卸载时取消尚未执行的帧，避免对已卸载组件绘制
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  return {
    containerRef,
    canvasRefs: { static: staticRef, boundary: boundaryRef, interaction: interactionRef },
    size,
    repaint
  }
}
