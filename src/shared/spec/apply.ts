/**
 * 阶段 ⑥：在已有数据集上应用新 spec，不重新解析 CSV。
 *
 * 设计要点：
 *  - 只改判定结果（site.pass / passCount）与 dataset.spec，绝不改动 value；
 *  - 判定口径必须与 parser 完全一致：
 *      1. valueType=passfail：以 CSV pass 列为准，spec 不参与（缺 token 即未知）；
 *      2. passSource=file：文件有 token 的格子沿用 token，空值回落到 spec；
 *      3. 其余（measured + derived）：全部按 spec 现算。
 *    保留的 `site.sourcePass` 让前两种模式在改 spec 后可以逐格复现。
 *  - 返回新对象，不原地修改传入的数据集，避免 React 依赖引用相等时漏更新。
 */

import {
  CELL_PASS,
  CELL_UNKNOWN,
  type CellState,
  type ShmooDataset,
  type SiteGrid,
  type SpecLimit
} from '../types/shmoo'
import { evaluateCell } from './evaluate'

/** 两个 spec 的判定语义是否相同（忽略字段顺序与 undefined） */
export function isSameSpec(a: SpecLimit, b: SpecLimit): boolean {
  return a.mode === b.mode && a.min === b.min && a.max === b.max && a.target === b.target
}

/** 复制 spec，去掉值为 undefined 的字段，保证序列化结果稳定 */
function cloneSpec(spec: SpecLimit): SpecLimit {
  const next: SpecLimit = { mode: spec.mode }
  if (typeof spec.min === 'number') next.min = spec.min
  if (typeof spec.max === 'number') next.max = spec.max
  if (typeof spec.target === 'number') next.target = spec.target
  return next
}

/**
 * 按新的判定规则重算单个 site。
 * value / valueRange 不变；knownCount 与 value 一一对应，也保持不变。
 */
function recomputeSite(site: SiteGrid, dataset: ShmooDataset, spec: SpecLimit): SiteGrid {
  const source = site.sourcePass ?? null
  const pass = new Uint8Array(site.value.length)
  let passCount = 0

  for (let i = 0; i < site.value.length; i++) {
    let state: CellState

    if (dataset.valueType === 'passfail') {
      // 二值数据：完全以文件的 pass 列为准；没有原始列时保留旧判定
      state = source ? (source[i] as CellState) : (site.pass[i] as CellState)
    } else if (dataset.passSource === 'file') {
      if (!source) {
        // 旧数据集没有保留原始 token，无法区分“文件给了什么”，只能保持原判定
        state = site.pass[i] as CellState
      } else if (source[i] !== CELL_UNKNOWN) {
        // 文件给出了 pass 列取值：spec 不影响它
        state = source[i] as CellState
      } else {
        // pass 列为空：与 parser 一致，回落到 spec 推导
        state = evaluateCell(site.value[i], spec)
      }
    } else {
      // measured + derived（默认）：全部由 spec 现算
      state = evaluateCell(site.value[i], spec)
    }

    pass[i] = state
    if (state === CELL_PASS) passCount++
  }

  return { ...site, pass, passCount }
}

/**
 * 应用新 spec 并返回一个新数据集（revision + 1）。
 * 调用方负责保证 spec 合法（见 input.ts 的 parseSpecInput）。
 */
export function applySpecToDataset(dataset: ShmooDataset, spec: SpecLimit): ShmooDataset {
  const nextSpec = cloneSpec(spec)
  return {
    ...dataset,
    spec: nextSpec,
    sites: dataset.sites.map((site) => recomputeSite(site, dataset, nextSpec)),
    revision: dataset.revision + 1
  }
}
