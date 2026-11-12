import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import { CELL_FAIL, CELL_PASS } from '@shared/types/shmoo'
import { DEFAULT_PADDING, cellCenter, computeGeometry, tickDecimals } from '../chart/geometry'
import { drawOneDInteraction, drawOneDStatic } from '../chart/render1d'
import type { OneDForm, OneDMotion } from '../chart/render1d'
import { computeMarginTints } from '../chart/colors'
import { isFlatBinaryDataset } from '@shared/spec/evaluate'
import { nearestSampleIndex } from '../chart/oneD'
import type { ChartPerf } from '../chart/perf'
import { useLayeredCanvas } from '../chart/useLayeredCanvas'
import type { LayerName, LayerRenderer } from '../chart/useLayeredCanvas'

/**
 * 1D Shmoo 图表组件。
 *
 * 与 2D 共用同一套三层画布与尺寸逻辑：
 *  - 静态层：色带 / 曲线、spec 线、坐标轴、图例；
 *  - 边界层：1D 不需要轮廓，保持空实现（层仍存在，保证 DOM 结构与 2D 完全一致，不产生布局跳动）；
 *  - 交互层：竖线吸附 + 当前点圈选。
 *
 * 入场动效只有一条从左到右的揭示（300ms），不使用逐点弹跳；
 * prefers-reduced-motion 开启时直接画最终状态。
 */

/** 1D 入场揭示时长（ms） */
const REVEAL_DURATION = 300
const TOOLTIP_OFFSET = 14
const TOOLTIP_WIDTH = 178
const TOOLTIP_HEIGHT = 96

interface Shmoo1DChartProps {
  dataset: ShmooDataset
  site: SiteGrid
  form: OneDForm
}

/** 值格式化：至少 2 位、最多 4 位小数，和 2D 浮层一致 */
function formatMeasure(value: number, range: { min: number; max: number } | null): string {
  if (!Number.isFinite(value)) return '—'
  const decimals = range ? Math.max(2, Math.min(4, tickDecimals([range.min, range.max]) + 1)) : 3
  return value.toFixed(decimals)
}

/** 减少动效偏好（与 Shmoo2DChart 相同的判定；测试环境无 matchMedia 时按开启处理） */
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

export function Shmoo1DChart({ dataset, site, form }: Shmoo1DChartProps): JSX.Element {
  const reducedMotion = useReducedMotion()

  const motionRef = useRef<OneDMotion>({ enabled: false, duration: 0, elapsed: 0 })
  const formRef = useRef<OneDForm>(form)
  formRef.current = form
  const perfRef = useRef<ChartPerf>({ static: [], boundary: [], interaction: [], frames: 0 })

  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [hoverVisible, setHoverVisible] = useState(false)
  const hoverIndexRef = useRef<number | null>(hoverIndex)
  const hoverVisibleRef = useRef(hoverVisible)
  hoverIndexRef.current = hoverIndex
  hoverVisibleRef.current = hoverVisible

  const recordTiming = useCallback((key: 'static' | 'boundary' | 'interaction', ms: number) => {
    const list = perfRef.current[key]
    list.push(ms)
    if (list.length > 240) list.shift()
  }, [])

  const marginTints = useMemo(
    () => computeMarginTints(site, dataset.spec),
    [site, dataset.spec, dataset.revision]
  )

  // 纯二值数据集（0/1 pattern / 无 value）：色带与曲线点改用饱和平涂系统色。
  // 数据集级一次性判定，绘制函数只读布尔值，不逐点判断。
  const flatBinary = useMemo(() => isFlatBinaryDataset(dataset), [dataset])

  const renderers = useMemo<Record<LayerName, LayerRenderer>>(() => {
    return {
      static: (ctx, size) => {
        const startedAt = performance.now()
        drawOneDStatic(ctx, size, {
          dataset,
          site,
          form: formRef.current,
          tint: marginTints,
          flatBinary,
          motion: motionRef.current
        })
        perfRef.current.frames += 1
        recordTiming('static', performance.now() - startedAt)
      },
      // 1D 没有 pass 区轮廓：保留空层，保证三层 canvas 的 DOM 结构与 2D 相同
      boundary: () => {},
      interaction: (ctx, size) => {
        const startedAt = performance.now()
        drawOneDInteraction(ctx, size, {
          dataset,
          site,
          form: formRef.current,
          index: hoverVisibleRef.current ? hoverIndexRef.current : null
        })
        recordTiming('interaction', performance.now() - startedAt)
      }
    }
  }, [dataset, site, marginTints, flatBinary, recordTiming])

  const { containerRef, canvasRefs, size, repaint } = useLayeredCanvas(renderers)

  const geometry = useMemo(
    () => computeGeometry(size.width, size.height, DEFAULT_PADDING, dataset.xAxis.values, [0]),
    [size.width, size.height, dataset.xAxis.values]
  )

  // ---- 入场：只揭示一次，不随 hover 重播；形态切换时重新播放（很轻的过渡） ----
  useEffect(() => {
    if (size.width < 2 || size.height < 2) return

    if (reducedMotion) {
      motionRef.current = { enabled: false, duration: 0, elapsed: 0 }
      repaint('all')
      return
    }

    const startedAt = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      const elapsed = now - startedAt
      motionRef.current = {
        enabled: true,
        duration: REVEAL_DURATION,
        elapsed
      }
      repaint('static')
      if (elapsed < REVEAL_DURATION) {
        raf = window.requestAnimationFrame(tick)
      } else {
        motionRef.current = { enabled: false, duration: 0, elapsed: 0 }
        repaint('all')
      }
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [dataset.id, site.siteId, form, reducedMotion, size.width > 0, size.height > 0, repaint])

  // 阶段 ⑥：spec 编辑后直接重绘（含切片视图），不重播揭示动画
  useLayoutEffect(() => {
    if (dataset.revision <= 0) return
    repaint('all')
  }, [dataset.revision, repaint])

  useEffect(() => {
    repaint('interaction')
  }, [hoverIndex, hoverVisible, repaint])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__shmooPerf = perfRef.current
  }, [])

  // ---- 指针交互：按像素 x 吸附到最近的采样点 ----
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const container = containerRef.current
    if (!container || size.width < 2) return

    const rect = container.getBoundingClientRect()
    const px = event.clientX - rect.left - container.clientLeft
    const py = event.clientY - rect.top - container.clientTop
    const { plot } = geometry
    if (px < plot.x || px > plot.x + plot.w || py < plot.y || py > plot.y + plot.h) {
      if (hoverVisible) setHoverVisible(false)
      return
    }

    const index = nearestSampleIndex(
      dataset.xAxis.values,
      px,
      plot.x,
      plot.w
    )
    if (index !== hoverIndex) setHoverIndex(index)
    if (!hoverVisible) setHoverVisible(true)
  }

  const handlePointerLeave = (): void => setHoverVisible(false)

  // ---- 浮层定位与读数 ----
  const xDecimals = useMemo(() => tickDecimals(dataset.xAxis.values), [dataset.xAxis.values])
  const hoverValue = hoverIndex !== null ? site.value[hoverIndex] : Number.NaN
  const hoverState = hoverIndex !== null ? site.pass[hoverIndex] : null
  const stateLabel =
    hoverState === CELL_PASS ? 'PASS' : hoverState === CELL_FAIL ? 'FAIL' : 'NO DATA'
  const stateClass =
    hoverState === CELL_PASS ? 'pass' : hoverState === CELL_FAIL ? 'fail' : 'unknown'

  const tooltipStyle = useMemo<CSSProperties>(() => {
    if (hoverIndex === null) return { display: 'none' }
    const center = cellCenter(geometry, hoverIndex, 0)
    const anchorY = form === 'band' ? geometry.plot.y + geometry.plot.h / 2 : center.y
    const flipX = center.x + TOOLTIP_OFFSET + TOOLTIP_WIDTH > size.width
    const flipY = anchorY + TOOLTIP_OFFSET + TOOLTIP_HEIGHT > size.height
    return {
      left: Math.round(center.x + (flipX ? -TOOLTIP_OFFSET : TOOLTIP_OFFSET)),
      top: Math.round(anchorY + (flipY ? -TOOLTIP_OFFSET : TOOLTIP_OFFSET)),
      transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`
    }
  }, [hoverIndex, geometry, form, size.width, size.height])

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
        aria-label={`1D Shmoo 图：${dataset.title}`}
        role="img"
      />
      {hoverIndex !== null ? (
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
              <dt>{dataset.xAxis.label}</dt>
              <dd className="mono">
                {dataset.xAxis.values[hoverIndex].toFixed(xDecimals)}
                {dataset.xAxis.unit ? <i> {dataset.xAxis.unit}</i> : null}
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
