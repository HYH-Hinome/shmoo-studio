import { CELL_UNKNOWN } from '@shared/types/shmoo'
import { createNoise2D } from './noise'

/**
 * 通过 / 失效区域轮廓提取 + 有机墨迹轮廓（纯函数，无 DOM 依赖）。
 *
 * 两层轮廓（缺一不可）：
 *  1. **精确边界层**：marching squares 从二值场提取闭合折线。二值场定义在“格子中心”，
 *     所以线性插值交点恰好落在相邻格子共享的**真实格子边界**上：
 *     水平相邻格 → 交点在竖直格线上；竖直相邻格 → 交点在水平格线上。
 *     不做任何位移与平滑，像素位置与数据一格不差，是判读依据。
 *  2. **有机墨迹层**：把精确轮廓重采样后，用 simplex 噪声做约格子尺寸 14% 的位移，
 *     再用闭合 Catmull-Rom 平滑，得到液态/墨迹感的色块外缘。它只作为填充形状，
 *     永远不会替代第 1 层。
 *
 * 已知难点的降级规则：
 *  - 连通区面积 < 4 格：不施加噪声，直接返回精确轮廓（避免单点/2×2 块抖成尖刺）；
 *  - 位移后自交：把振幅减半重试（最多 2 次），仍失败则放弃墨迹、退回精确轮廓；
 *  - 缺测格（NaN / 无数据）：二值场里按 0 处理，因此精确轮廓不会跨过去；
 *    墨迹采样点若落入缺测格，同样视为失败并触发降半振幅重试，保证墨迹不侵入缺测区；
 *  - 每条平滑采样点到“它来源的那条精确边”的距离强制夹在 15% 格宽内，
 *    防止 Catmull-Rom 过冲导致偏差超标。
 *
 * 结果按数据集缓存：轮廓提取与噪声位移只在首次绘制时计算一次，不参与逐帧重绘。
 */

/** 平面点（CSS 像素） */
export interface Pt {
  x: number
  y: number
}

/** 一个连通区的两层轮廓 */
export interface InkRegion {
  /** pass / fail */
  state: 'pass' | 'fail'
  /** 连通区编号（同一状态内唯一，用于调试与测试） */
  label: number
  /** 连通区包含的格子数 */
  area: number
  /** 连通区的格子索引（row-major：iy * nx + ix），用于明度调制叠加 */
  cells: number[]
  /** 精确轮廓：闭合折线（首尾相同），落在真实格子边界上 */
  exactLoops: Pt[][]
  /** 墨迹轮廓：与 exactLoops 一一对应；null 表示该环降级为精确轮廓 */
  inkLoops: Array<Pt[] | null>
  /** 连通区重心（CSS 像素），入场分层按它到图心的距离计算 */
  anchor: Pt
  /** 是否成功施加了噪声位移 */
  softened: boolean
}

/** 整幅图的轮廓场景 */
export interface InkScene {
  regions: InkRegion[]
  /** 是否发生过降级（存在 < 4 格的区域或自交回退），供测试与调试 */
  degraded: boolean
}

/** 墨迹噪声的振幅上限：格子尺寸的比例（验收上限约 15%） */
export const INK_AMPLITUDE_RATIO = 0.14
/** 平滑后采样点到精确边的最大允许距离（格子尺寸的比例） */
export const INK_MAX_DEVIATION_RATIO = 0.15
/** 面积小于该值的连通区不做噪声位移（单点、2×2 块等稀疏数据） */
export const MIN_INK_AREA = 4
/** 单条环的重采样点数上限，防止极端周长导致计算量失控 */
const MAX_LOOP_SAMPLES = 400
/** 每条 Catmull-Rom 段内的采样数 */
const SPLINE_SUBDIVISION = 6

/** 判断格子是否属于目标状态（未知格永远不属于任何区域） */
function isTarget(state: number, target: number): boolean {
  return state === target
}

/** 取格子中心坐标；越界时按镜像外推半格，用于构造图外的虚拟采样点 */
function centerX(edgesX: number[], i: number): number {
  const nx = edgesX.length - 1
  if (i < 0) return 1.5 * edgesX[0] - 0.5 * edgesX[1]
  if (i >= nx) {
    const end = edgesX[nx]
    return end + (end - (edgesX[nx] + edgesX[nx - 1]) / 2)
  }
  return (edgesX[i] + edgesX[i + 1]) / 2
}

/** y 轴同理：edgesY 从底到顶（像素值递减），镜像外推仍然成立 */
function centerY(edgesY: number[], j: number): number {
  const ny = edgesY.length - 1
  if (j < 0) return 1.5 * edgesY[0] - 0.5 * edgesY[1]
  if (j >= ny) {
    const end = edgesY[ny]
    return end + (end - (edgesY[ny] + edgesY[ny - 1]) / 2)
  }
  return (edgesY[j] + edgesY[j + 1]) / 2
}

/** 4 邻接连通区标记（row-major，iy = 0 在最下方） */
function labelComponents(
  state: Uint8Array,
  nx: number,
  ny: number,
  target: number
): { labels: Int32Array; count: number; sizes: number[] } {
  const labels = new Int32Array(nx * ny).fill(-1)
  const sizes: number[] = []
  let count = 0
  const stack: number[] = []

  for (let start = 0; start < labels.length; start++) {
    if (labels[start] !== -1) continue
    if (!isTarget(state[start], target)) continue

    const label = count++
    let size = 0
    labels[start] = label
    stack.push(start)

    while (stack.length > 0) {
      const index = stack.pop() as number
      size++
      const ix = index % nx
      const iy = (index - ix) / nx
      // 只走 4 邻接：对角相接的两块视为不同连通区（与 marching squares 的 4 连通消歧一致）
      const neighbours = [
        ix > 0 ? index - 1 : -1,
        ix < nx - 1 ? index + 1 : -1,
        iy > 0 ? index - nx : -1,
        iy < ny - 1 ? index + nx : -1
      ]
      for (const next of neighbours) {
        if (next < 0) continue
        if (labels[next] !== -1) continue
        if (!isTarget(state[next], target)) continue
        labels[next] = label
        stack.push(next)
      }
    }
    sizes.push(size)
  }

  return { labels, count, sizes }
}

/** 去掉共线的中间点：轮廓只保留拐点，平滑时不会被密集同向点拖平 */
function simplifyCollinear(points: Pt[]): Pt[] {
  if (points.length < 4) return points.slice()
  // 入参是“每个拐点各出现一次”的闭合环（末尾没有重复首点）
  const open = points
  const result: Pt[] = []
  const n = open.length

  for (let i = 0; i < n; i++) {
    const prev = open[(i - 1 + n) % n]
    const current = open[i]
    const next = open[(i + 1) % n]
    const cross =
      (current.x - prev.x) * (next.y - current.y) - (current.y - prev.y) * (next.x - current.x)
    // 共线（含 180° 折返）就丢掉当前点；保留拐点即可
    if (Math.abs(cross) < 1e-9) continue
    result.push(current)
  }
  if (result.length < 3) return points.slice()
  result.push({ ...result[0] })
  return result
}

/**
 * 提取某个连通区的闭合轮廓（精确层）。
 *
 * 关于 marching squares：如果按“格子中心”采样，二值场的等值线会整体内缩半格，
 * 单个格子会变成一个切进格子内部的菱形，直接违反“落在真实格子边界上、一格不差”。
 * 因此这里使用 marching squares 在二重网格上的等价形式——沿格子边界追踪：
 * 每条“暴露”的格子边就是一条等值线段，端点就是格点，天然落在真实格线上。
 *
 * 方向固定为“区域在左侧”，于是外环逆时针、孔洞顺时针，
 * 用非零填充规则一次填充即可自动挖洞，不需要额外做环的嵌套判断。
 */
function extractLoops(
  edgesX: number[],
  edgesY: number[],
  labels: Int32Array,
  label: number,
  nx: number,
  ny: number
): Pt[][] {
  const stride = nx + 1
  const vertexKey = (ix: number, iy: number): number => iy * stride + ix
  const belongs = (ix: number, iy: number): boolean =>
    ix >= 0 && iy >= 0 && ix < nx && iy < ny && labels[iy * nx + ix] === label

  // 有向边：from 顶点 → to 顶点（区域在左侧）
  const outgoing = new Map<number, number[]>()
  const addEdge = (from: number, to: number): void => {
    const list = outgoing.get(from)
    if (list) list.push(to)
    else outgoing.set(from, [to])
  }

  let edgeCount = 0
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (labels[iy * nx + ix] !== label) continue
      // 下边：下方不是本区域 → 从左到右
      if (!belongs(ix, iy - 1)) {
        addEdge(vertexKey(ix, iy), vertexKey(ix + 1, iy))
        edgeCount++
      }
      // 右边：右侧不是本区域 → 从下到上
      if (!belongs(ix + 1, iy)) {
        addEdge(vertexKey(ix + 1, iy), vertexKey(ix + 1, iy + 1))
        edgeCount++
      }
      // 上边：上方不是本区域 → 从右到左
      if (!belongs(ix, iy + 1)) {
        addEdge(vertexKey(ix + 1, iy + 1), vertexKey(ix, iy + 1))
        edgeCount++
      }
      // 左边：左侧不是本区域 → 从上到下
      if (!belongs(ix - 1, iy)) {
        addEdge(vertexKey(ix, iy + 1), vertexKey(ix, iy))
        edgeCount++
      }
    }
  }

  const toPoint = (key: number): Pt => {
    const ix = key % stride
    const iy = (key - ix) / stride
    return { x: edgesX[ix], y: edgesY[iy] }
  }

  const loops: Pt[][] = []
  let guard = 0

  while (outgoing.size > 0 && guard++ < edgeCount + 8) {
    const startKey = outgoing.keys().next().value as number
    let currentKey = startKey
    const points: Pt[] = []
    let steps = 0

    while (steps++ <= edgeCount) {
      const list = outgoing.get(currentKey)
      if (!list || list.length === 0) break
      const nextKey = list.shift() as number
      if (list.length === 0) outgoing.delete(currentKey)

      // 记录每条边的起点；整条环闭合后由 simplifyCollinear 补回收尾点
      points.push(toPoint(currentKey))
      currentKey = nextKey
      if (currentKey === startKey) break
    }

    if (currentKey !== startKey || points.length < 4) continue
    const simplified = simplifyCollinear(points)
    if (simplified.length >= 4) loops.push(simplified)
  }

  return loops
}

/** 闭合折线按弧长重采样（保证噪声位移在周长上均匀分布） */
function resampleClosed(points: Pt[], step: number): Pt[] {
  // 去掉重复收尾点后按“开折线”累加，再首尾相接
  const open = points.slice(0, -1)
  const n = open.length
  if (n < 3) return points.slice()

  const lengths: number[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const a = open[i]
    const b = open[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    lengths.push(len)
    total += len
  }
  if (!(total > 0)) return points.slice()

  const count = Math.max(8, Math.min(MAX_LOOP_SAMPLES, Math.ceil(total / step)))
  const result: Pt[] = []
  let target = 0
  let accumulated = 0

  for (let i = 0; i < n && result.length < count; i++) {
    const a = open[i]
    const b = open[(i + 1) % n]
    const len = lengths[i]
    const stepLen = total / count

    while (target < total && accumulated + len >= target && len > 0) {
      const t = (target - accumulated) / len
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      target += stepLen
    }
    accumulated += len
  }

  if (result.length < 3) return points.slice()
  result.push({ ...result[0] })
  return result
}

/** 点到线段的最近点 */
function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { x: a.x, y: a.y }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return { x: a.x + dx * t, y: a.y + dy * t }
}

/** 距离（供防止 Catmull-Rom 过冲的夹紧使用） */
function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 线段相交判定（用于墨迹自交检查） */
function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const d1 = d(p3, p4, p1)
  const d2 = d(p3, p4, p2)
  const d3 = d(p1, p2, p3)
  const d4 = d(p1, p2, p4)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true
  }
  // 共线重叠/端点接触也算自交（墨迹层宁可保守回退）
  const onSegment = (a: Pt, b: Pt, c: Pt): boolean =>
    Math.min(a.x, b.x) - 1e-6 <= c.x &&
    c.x <= Math.max(a.x, b.x) + 1e-6 &&
    Math.min(a.y, b.y) - 1e-6 <= c.y &&
    c.y <= Math.max(a.y, b.y) + 1e-6
  if (Math.abs(d1) < 1e-6 && onSegment(p3, p4, p1)) return true
  if (Math.abs(d2) < 1e-6 && onSegment(p3, p4, p2)) return true
  if (Math.abs(d3) < 1e-6 && onSegment(p1, p2, p3)) return true
  if (Math.abs(d4) < 1e-6 && onSegment(p1, p2, p4)) return true
  return false
}

/** 闭合折线是否自交（跳过相邻段与首尾相接的段） */
function hasSelfIntersection(points: Pt[]): boolean {
  const open = points.slice(0, -1)
  const n = open.length
  if (n < 4) return false
  for (let i = 0; i < n; i++) {
    const a1 = open[i]
    const a2 = open[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const b1 = open[j]
      const b2 = open[(j + 1) % n]
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }
  return false
}

/**
 * 闭合 Catmull-Rom 平滑。
 * 入参是控制点（已做噪声位移），返回加密后的折线（首尾相同）。
 */
function smoothClosed(points: Pt[], subdivision: number): Pt[] {
  const n = points.length
  if (n < 3) return points.slice()
  const result: Pt[] = []

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    for (let s = 0; s < subdivision; s++) {
      const t = s / subdivision
      const t2 = t * t
      const t3 = t2 * t
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3)
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      result.push({ x, y })
    }
  }
  result.push({ ...result[0] })
  return result
}

/** 二分查找：edges 升序（x 轴） */
function findAscending(edges: number[], value: number): number {
  if (value < edges[0] || value >= edges[edges.length - 1]) return -1
  let lo = 0
  let hi = edges.length - 2
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (value < edges[mid]) hi = mid - 1
    else if (value >= edges[mid + 1]) lo = mid + 1
    else return mid
  }
  return -1
}

/** 二分查找：edges 递减（y 轴：edges[0] 在底部，像素值最大） */
function findDescending(edges: number[], value: number): number {
  if (value > edges[0] || value <= edges[edges.length - 1]) return -1
  let lo = 0
  let hi = edges.length - 2
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (value > edges[mid]) hi = mid - 1
    else if (value <= edges[mid + 1]) lo = mid + 1
    else return mid
  }
  return -1
}

/** 判断点是否落在缺测格内（图外不算缺测，允许墨迹在图边外微微外溢） */
function isUnknownAt(
  pt: Pt,
  edgesX: number[],
  edgesY: number[],
  state: Uint8Array,
  nx: number,
  ny: number
): boolean {
  const ix = findAscending(edgesX, pt.x)
  const iy = findDescending(edgesY, pt.y)
  if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return false
  if (state[iy * nx + ix] !== CELL_UNKNOWN) return false

  // 恰好压在缺测格边界上不算“侵入”：允许墨迹贴边，但不允许进到格子内部
  const left = edgesX[ix]
  const right = edgesX[ix + 1]
  const low = Math.min(edgesY[iy], edgesY[iy + 1])
  const high = Math.max(edgesY[iy], edgesY[iy + 1])
  const epsilon = 1e-6
  return pt.x > left + epsilon && pt.x < right - epsilon && pt.y > low + epsilon && pt.y < high - epsilon
}

/** 闭合折线的绝对面积（像素²） */
function polygonArea(points: Pt[]): number {
  let sum = 0
  for (let i = 0; i < points.length - 1; i++) {
    sum += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y
  }
  return Math.abs(sum) / 2
}

/**
 * 生成一条精确轮廓的墨迹版本。
 * 返回 null 表示降级（面积过小 / 自交 / 侵入缺测格 / 兜底失败）。
 *
 * @param loopArea 环自身围出的面积（像素²）；用于判断“这一圈”是否太小，
 *                 不能拿整个连通区面积来判断，否则大区域里的微小孔洞也会被抖动。
 */
function buildInkLoop(
  exact: Pt[],
  loopArea: number,
  cellSize: number,
  seed: number,
  edgesX: number[],
  edgesY: number[],
  state: Uint8Array,
  nx: number,
  ny: number
): Pt[] | null {
  // 面积不足 4 格：单点、2×2 块等稀疏数据，噪声位移只会抖成尖刺，直接降级
  const cellArea = loopArea / Math.max(1, cellSize * cellSize)
  if (cellArea < MIN_INK_AREA) return null
  if (cellSize < 2) return null

  // 采样间距取 0.7 格：足够表现墨迹的有机构成，又不会让点位过密
  const controls = resampleClosed(exact, Math.max(1, cellSize * 0.7))
  const openControls = controls.slice(0, -1)
  if (openControls.length < 4) return null

  const noise = createNoise2D(seed)
  // 噪声空间频率：特征尺度约 3 格，避免出现高频锯齿
  const frequency = 1 / Math.max(1, cellSize * 3)
  const baseAmplitude = cellSize * INK_AMPLITUDE_RATIO
  const maxDeviation = cellSize * INK_MAX_DEVIATION_RATIO

  // 振幅减半重试：第一次 100%，之后 50% / 25%
  for (let attempt = 0; attempt < 3; attempt++) {
    const amplitude = baseAmplitude * Math.pow(0.5, attempt)
    const displaced: Pt[] = openControls.map((pt, index) => {
      // 两个不同相位的噪声场分别驱动 x / y，得到液态而非“整体平移”的效果
      const n1 = noise(pt.x * frequency + index * 0.0007, pt.y * frequency)
      const n2 = noise(pt.x * frequency + 31.4, pt.y * frequency + 17.7)
      let dx = n1 * amplitude
      let dy = n2 * amplitude
      const len = Math.hypot(dx, dy)
      // 位移向量长度不超过 15% 格宽（给平滑过冲留 1% 余量）
      const cap = cellSize * 0.15
      if (len > cap) {
        dx = (dx / len) * cap
        dy = (dy / len) * cap
      }
      return { x: pt.x + dx, y: pt.y + dy }
    })

    // 自交：控制点多于 3 个时检查；失败就降半振幅重试
    if (hasSelfIntersection([...displaced, { ...displaced[0] }])) continue

    const smoothed = smoothClosed(displaced, SPLINE_SUBDIVISION)

    // 1) 夹紧过冲：每个平滑点到其来源控制段的距离不超过 15% 格宽
    let overflow = false
    for (let i = 0; i < smoothed.length - 1; i++) {
      const sourceIndex = Math.floor(i / SPLINE_SUBDIVISION) % displaced.length
      const a = displaced[sourceIndex]
      const b = displaced[(sourceIndex + 1) % displaced.length]
      const near = nearestOnSegment(smoothed[i], a, b)
      const dist = distance(smoothed[i], near)
      if (dist > maxDeviation) {
        const k = maxDeviation / dist
        smoothed[i] = {
          x: near.x + (smoothed[i].x - near.x) * k,
          y: near.y + (smoothed[i].y - near.y) * k
        }
        overflow = true
      }
    }
    // 过冲被夹紧后形状可能已经变形，直接进入下一次尝试更稳妥
    if (overflow) continue

    // 2) 缺测格保护：任何采样点落入 NaN 格都视为失败
    let intrudes = false
    for (const pt of smoothed) {
      if (isUnknownAt(pt, edgesX, edgesY, state, nx, ny)) {
        intrudes = true
        break
      }
    }
    if (intrudes) continue

    return smoothed
  }

  return null
}

/** 缓存键：轮廓只与形状（格子状态）和像素尺寸有关 */
function sceneKey(edgesX: number[], edgesY: number[], seed: number): string {
  const nx = edgesX.length - 1
  const ny = edgesY.length - 1
  return `${nx}x${ny}|${(edgesX[nx] - edgesX[0]).toFixed(2)}x${(edgesY[0] - edgesY[ny]).toFixed(2)}|${seed}`
}

/** 每个状态数组一份缓存（site.pass 的引用在数据集生命周期内稳定） */
const sceneCache = new WeakMap<Uint8Array, Map<string, InkScene>>()

/**
 * 提取整幅图的轮廓场景（PASS + FAIL）。
 *
 * @param edgesX 竖直格线像素位置（升序，长度 nx + 1）
 * @param edgesY 水平格线像素位置（从底到顶，像素值递减，长度 ny + 1）
 * @param state 每格状态（row-major，iy = 0 在最下方）
 * @param seed 噪声种子；同一数据集传相同值可复用缓存
 */
export function buildInkScene(
  edgesX: number[],
  edgesY: number[],
  state: Uint8Array,
  seed = 1337
): InkScene {
  const nx = edgesX.length - 1
  const ny = edgesY.length - 1
  if (nx <= 0 || ny <= 0 || state.length < nx * ny) return { regions: [], degraded: false }

  const key = sceneKey(edgesX, edgesY, seed)
  const cached = sceneCache.get(state)?.get(key)
  if (cached) return cached

  const cellSize = Math.min(
    (edgesX[nx] - edgesX[0]) / nx,
    Math.abs(edgesY[0] - edgesY[ny]) / ny
  )

  const regions: InkRegion[] = []
  let degraded = false
  let labelOffset = 0

  for (const target of [1, 0] as const) {
    const stateName: 'pass' | 'fail' = target === 1 ? 'pass' : 'fail'
    const { labels, count, sizes } = labelComponents(state, nx, ny, target)

    // 按连通区聚合格子
    const cellsByLabel: number[][] = Array.from({ length: count }, () => [])
    for (let index = 0; index < labels.length; index++) {
      if (labels[index] >= 0) cellsByLabel[labels[index]].push(index)
    }

    for (let label = 0; label < count; label++) {
      const cells = cellsByLabel[label]
      if (cells.length === 0) continue

      // 精确轮廓按连通区逐个提取（区域在左、孔洞自动反向）
      const exactLoops = extractLoops(edgesX, edgesY, labels, label, nx, ny)
      if (exactLoops.length === 0) {
        degraded = true
        continue
      }

      const area = sizes[label] ?? cells.length
      if (area < MIN_INK_AREA) degraded = true

      // 重心：格子中心的平均值，用于入场分层
      let sumX = 0
      let sumY = 0
      for (const index of cells) {
        const ix = index % nx
        const iy = (index - ix) / nx
        sumX += centerX(edgesX, ix)
        sumY += centerY(edgesY, iy)
      }
      const anchor: Pt = { x: sumX / cells.length, y: sumY / cells.length }

      // 每个连通区用不同的种子，避免相邻区域的噪声形态完全一致
      const seedForRegion = (seed + labelOffset * 7919 + area * 131) >>> 0
      const inkLoops = exactLoops.map((loop) =>
        buildInkLoop(loop, polygonArea(loop), cellSize, seedForRegion, edgesX, edgesY, state, nx, ny)
      )
      const softened = inkLoops.some((loop) => loop !== null)
      if (!softened) degraded = true

      regions.push({
        state: stateName,
        label: labelOffset + label,
        area,
        cells,
        exactLoops,
        inkLoops,
        anchor,
        softened
      })
    }

    labelOffset += count
  }

  const scene: InkScene = { regions, degraded }
  if (!sceneCache.has(state)) sceneCache.set(state, new Map())
  ;(sceneCache.get(state) as Map<string, InkScene>).set(key, scene)
  return scene
}
