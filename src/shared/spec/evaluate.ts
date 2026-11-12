import {
  CELL_FAIL,
  CELL_PASS,
  CELL_UNKNOWN,
  type CellEvaluation,
  type CellState,
  type ShmooDataset,
  type SpecLimit,
  type SpecSide
} from '../types/shmoo'

/**
 * spec 是否配置完整。
 * - none：显式声明不比较 spec，视为“没有可用的 spec”；
 * - window：min 与 max 都必须有（min === max 也合法，表示只接受恰好等于该值）；
 * - min / max：对应的那一边必须有。
 */
export function isSpecComplete(spec: SpecLimit): boolean {
  if (spec.mode === 'none') return false
  if (spec.mode === 'window') {
    return typeof spec.min === 'number' && typeof spec.max === 'number'
  }
  if (spec.mode === 'min') return typeof spec.min === 'number'
  return typeof spec.max === 'number'
}

/**
 * 双边窗口是否退化成一个点（min === max）。
 * 这种 spec 用于 0/1 pattern：只有恰好等于该值才算 pass。
 */
export function isZeroWidthWindow(spec: SpecLimit): boolean {
  return (
    spec.mode === 'window' &&
    typeof spec.min === 'number' &&
    typeof spec.max === 'number' &&
    spec.min === spec.max
  )
}

/**
 * 单点三态判定（spec 推导）。
 * 无数据（NaN）永远返回 unknown，不能算失败 —— 这是整个工具的核心语义之一。
 * spec 为 none / 不完整时同样返回 unknown，而不是默认 fail。
 */
export function evaluateCell(value: number, spec: SpecLimit): CellState {
  if (!Number.isFinite(value) || !isSpecComplete(spec)) return CELL_UNKNOWN

  if (spec.mode === 'max' && typeof spec.max === 'number') {
    return value <= spec.max ? CELL_PASS : CELL_FAIL
  }
  if (spec.mode === 'min' && typeof spec.min === 'number') {
    return value >= spec.min ? CELL_PASS : CELL_FAIL
  }
  if (typeof spec.min === 'number' && typeof spec.max === 'number') {
    // min === max 时，>= 与 <= 同时成立 ⇔ 恰好等于该值
    return value >= spec.min && value <= spec.max ? CELL_PASS : CELL_FAIL
  }
  return CELL_UNKNOWN
}

/**
 * 计算 margin（到最近边界的距离，与测量值同单位，正值表示在规格内），
 * 同时记录 margin 来自哪一条边界（side）。
 *
 * 口径：
 *  - 双边：margin = min(value - min, max - value)，side 取距离更近的一边；
 *    越界时为负值，side 指向被越过的那条边界（就是用户说的“撞哪一边”）；
 *  - 单边：margin 为到唯一边界的距离，side 恒为对应边。
 *  - 百分比：双边 margin / (max - min)；单边 margin / |limit|；
 *    分母为 0（min === max）时无法归一，返回 null。
 */
export function evaluatePoint(value: number, spec: SpecLimit): CellEvaluation {
  const state = evaluateCell(value, spec)
  if (state === CELL_UNKNOWN) return { state, margin: null, marginPct: null, side: null }

  let margin: number | null = null
  let span: number | null = null
  let side: SpecSide | null = null

  if (spec.mode === 'window' && typeof spec.min === 'number' && typeof spec.max === 'number') {
    const distanceToMin = value - spec.min
    const distanceToMax = spec.max - value
    margin = Math.min(distanceToMin, distanceToMax)
    // 距离相等时归入下限一侧，保证 side 永远有确定值
    side = distanceToMin <= distanceToMax ? 'min' : 'max'
    span = spec.max - spec.min
  } else if (spec.mode === 'max' && typeof spec.max === 'number') {
    margin = spec.max - value
    span = Math.abs(spec.max)
    side = 'max'
  } else if (spec.mode === 'min' && typeof spec.min === 'number') {
    margin = value - spec.min
    span = Math.abs(spec.min)
    side = 'min'
  }

  const marginPct = margin !== null && span !== null && span > 0 ? margin / span : null
  return { state, margin, marginPct, side }
}

/* ------------------------------------------------------------------ *
 * 数据形态判断（纯显示层使用，不影响解析与判定结果）
 * ------------------------------------------------------------------ */

/**
 * 统计整个数据集里出现过的不同测量值个数，最多数到 limit 个就提前返回。
 * 缺失点（NaN）不参与统计。
 */
export function distinctValueCount(dataset: ShmooDataset, limit = 3): number {
  const seen = new Set<number>()
  for (const site of dataset.sites) {
    for (let i = 0; i < site.value.length; i++) {
      const value = site.value[i]
      if (!Number.isFinite(value)) continue
      seen.add(value)
      if (seen.size >= limit) return seen.size
    }
  }
  return seen.size
}

/**
 * 热力模式是否仍有意义。
 *
 * 热力图把“数值高低”映射成色相；当整个数据集只有 1–2 种取值
 * （典型是 0/1 pattern）时没有连续量可映射，应把热力入口置灰。
 * 这是纯显示层判断：数据模型、解析与判定都不受影响。
 */
export function isHeatMeaningful(dataset: ShmooDataset): boolean {
  return distinctValueCount(dataset, 3) > 2
}

/**
 * 是否为“纯二值”数据集（没有连续量可表达）。
 *
 * 判定口径（数据集级，解析后一次性决定，不在渲染里逐格判断）：
 *  - 文件声明了 value_type: passfail；或
 *  - 整个值域只有 1–2 种取值（典型是 0/1 pattern，即使声明成 measured）。
 *
 * 这类数据没有 |margin| 的连续含义，二值色块应改为饱和平涂（iOS 系统红绿），
 * 图例也随之切换成“二值判定”。纯粹是显示层判断，不影响解析与判定结果。
 */
export function isFlatBinaryDataset(dataset: ShmooDataset): boolean {
  return dataset.valueType === 'passfail' || !isHeatMeaningful(dataset)
}

/**
 * margin 是否有物理意义（决定规格面板显示数字还是“不适用”）。
 *
 * 以下情况 margin 只是形式上的数字、容易误导：
 *  - spec 为 none / 不完整；
 *  - 双边窗口宽度为 0（min === max，例如 pattern 的 min=1,max=1）；
 *  - 值域只有 1–2 种取值（离散 pattern，margin 只能取 0 与某个常量）。
 */
export function isMarginMeaningful(dataset: ShmooDataset): boolean {
  const spec = dataset.spec
  if (!isSpecComplete(spec)) return false
  if (isZeroWidthWindow(spec)) return false
  if (!isHeatMeaningful(dataset)) return false
  return true
}
