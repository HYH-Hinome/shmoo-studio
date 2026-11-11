import { describe, expect, it } from 'vitest'
import { CELL_UNKNOWN, type ShmooDataset } from '@shared/types/shmoo'
import { parseShmooCsv } from '@shared/csv/parser'
import {
  DEFAULT_PADDING,
  cellCenter,
  cellRect,
  computeGeometry,
  hitTest,
  pickTickIndices
} from '@renderer/chart/geometry'

/**
 * 网格尺寸健壮性测试（阶段 ③c 追加）。
 *
 * 背景：30×30 只是样例，实际数据的行列数不固定，可能是 1×30、5×8、100×100，
 * 甚至是只有一个点的退化数据集。这里用**真实解析链路**（CSV → 轴 → 网格）造数据，
 * 再断言几何层没有任何隐含的尺寸假设：
 *  1. 轴长完全由数据里实际出现的取值决定，不补齐到方形；
 *  2. n 个采样点必须产生 n+1 条边界、n 个色块（常见 off-by-one 回归）；
 *  3. 所有色块面积之和 = 数据区面积（无缝隙、无重叠）；
 *  4. 非方形网格允许矩形格子，不强行拉成正方形；
 *  5. 缺失点进入 UNKNOWN，不计入 pass/fail，统计数正确；
 *  6. 刻度抽稀在密集时确实减少标签数量，且首尾刻度始终保留。
 */

const CHART_WIDTH = 800
const CHART_HEIGHT = 600

/** 与 render2d.drawAxes 保持一致的抽稀间距（x 轴按文字宽度估算，y 轴按行高） */
const X_MIN_GAP = 36
const Y_MIN_GAP = 28

/** 拼一份最小 2D CSV：通过 spec 推导 pass，值统一 800（> min=720 即 PASS） */
function makeCsv(nx: number, ny: number, omitted: number[] = []): string {
  const skip = new Set(omitted)
  const rows: string[] = []
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (skip.has(iy * nx + ix)) continue
      const x = (0.6 + ix * 0.01).toFixed(2)
      const y = 100 + iy * 10
      rows.push(`${x},${y},1,,800`)
    }
  }
  return [
    '# kind: 2d',
    '# x_label: VDD',
    '# x_unit: V',
    '# y_label: PERIOD',
    '# y_unit: ns',
    '# value_label: VOH',
    '# value_unit: mV',
    '# value_type: measured',
    '# spec: min=720',
    '# pass_source: derived',
    'x,y,site,pass,value',
    ...rows
  ].join('\n')
}

/** 解析并返回数据集；失败直接抛错，避免后续断言拿到 null 时信息不清 */
function parseGrid(nx: number, ny: number, omitted: number[] = []): ShmooDataset {
  const { dataset } = parseShmooCsv(makeCsv(nx, ny, omitted), { fileName: `grid-${nx}x${ny}.csv` })
  if (!dataset) throw new Error(`grid-${nx}x${ny}.csv 解析失败`)
  return dataset
}

/** 用数据集真实的轴值算几何（与组件走同一条路径） */
function geometryOf(dataset: ShmooDataset) {
  return computeGeometry(
    CHART_WIDTH,
    CHART_HEIGHT,
    DEFAULT_PADDING,
    dataset.xAxis.values,
    dataset.yAxis?.values ?? []
  )
}

describe('网格尺寸不固定：轴长与色块数量', () => {
  const cases: Array<{ name: string; nx: number; ny: number }> = [
    { name: '1×30（单列）', nx: 1, ny: 30 },
    { name: '30×1（单行）', nx: 30, ny: 1 },
    { name: '5×8（非方形）', nx: 5, ny: 8 },
    { name: '100×100（密集）', nx: 100, ny: 100 },
    { name: '1×1（只有一个点）', nx: 1, ny: 1 }
  ]

  for (const { name, nx, ny } of cases) {
    it(`${name}：轴长 = 实际取值数，色块数 = nx × ny`, () => {
      const dataset = parseGrid(nx, ny)
      expect(dataset.xAxis.values).toHaveLength(nx)
      expect(dataset.yAxis?.values).toHaveLength(ny)

      const geometry = geometryOf(dataset)
      // n 个采样点 → n+1 条边界；不能少画一个格子
      expect(geometry.x.edges).toHaveLength(nx + 1)
      expect(geometry.y.edges).toHaveLength(ny + 1)
      expect(geometry.x.edges.length - 1).toBe(nx)
      expect(geometry.y.edges.length - 1).toBe(ny)

      // 边界必须严格单调（x 递增、y 递减），否则 hitTest 的二分查找会失效
      for (let i = 1; i < geometry.x.edges.length; i++) {
        expect(geometry.x.edges[i]).toBeGreaterThan(geometry.x.edges[i - 1])
      }
      for (let i = 1; i < geometry.y.edges.length; i++) {
        expect(geometry.y.edges[i]).toBeLessThan(geometry.y.edges[i - 1])
      }

      // 面积守恒：nx × ny 个色块正好铺满数据区，既无缝隙也无重叠
      let area = 0
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const rect = cellRect(geometry, ix, iy)
          expect(rect.w).toBeGreaterThan(0)
          expect(rect.h).toBeGreaterThan(0)
          area += rect.w * rect.h
        }
      }
      expect(area).toBeCloseTo(geometry.plot.w * geometry.plot.h, 4)
    })

    it(`${name}：四角都能命中自身格子`, () => {
      const dataset = parseGrid(nx, ny)
      const geometry = geometryOf(dataset)
      const corners: Array<[number, number]> = [
        [0, 0],
        [nx - 1, 0],
        [0, ny - 1],
        [nx - 1, ny - 1]
      ]
      for (const [ix, iy] of corners) {
        const center = cellCenter(geometry, ix, iy)
        expect(hitTest(geometry, center.x, center.y)).toEqual({ ix, iy })
      }
    })
  }

  it('非方形网格：格子保持矩形，不被强行拉成正方形', () => {
    const dataset = parseGrid(5, 8)
    const geometry = geometryOf(dataset)
    const rect = cellRect(geometry, 0, 0)
    // 5 列 8 行 → 横向格子必然比纵向宽；如果代码里把格子强行改成正方形，
    // 就会在这里出现 w ≈ h，同时数据区出现空白。
    expect(rect.w).not.toBeCloseTo(rect.h, 1)
    expect(rect.w).toBeCloseTo(geometry.plot.w / 5, 6)
    expect(rect.h).toBeCloseTo(geometry.plot.h / 8, 6)
  })

  it('单点数据集：仍画出 1 个格子，铺满数据区', () => {
    const dataset = parseGrid(1, 1)
    const geometry = geometryOf(dataset)
    const rect = cellRect(geometry, 0, 0)
    expect(rect.w).toBeCloseTo(geometry.plot.w, 6)
    expect(rect.h).toBeCloseTo(geometry.plot.h, 6)
    expect(hitTest(geometry, cellCenter(geometry, 0, 0).x, cellCenter(geometry, 0, 0).y)).toEqual({
      ix: 0,
      iy: 0
    })
  })
})

describe('缺测统计：缺失点是 UNKNOWN，不是 fail', () => {
  it('5×8 网格留空 3 格 → knownCount = 37，缺失率 = 3/40', () => {
    const omitted = [0, 17, 39] // 分别位于首格、中间格、末格
    const { dataset, report } = parseShmooCsv(makeCsv(5, 8, omitted), {
      fileName: 'grid-5x8-missing.csv'
    })
    expect(dataset).not.toBeNull()
    const data = dataset as ShmooDataset
    const site = data.sites[0]

    expect(site.value).toHaveLength(40)
    expect(site.knownCount).toBe(37)
    expect(site.passCount).toBe(37)
    expect(report.missingRatio).toBeCloseTo(3 / 40, 6)
    // 缺失格的值是 NaN，判定是 UNKNOWN
    for (const index of omitted) {
      expect(Number.isNaN(site.value[index])).toBe(true)
      expect(site.pass[index]).toBe(CELL_UNKNOWN)
    }
  })

  it('100×100 网格留空 250 格 → knownCount = 9750，缺失率 = 2.5%', () => {
    // 每 40 格留空 1 格，共 10000 / 40 = 250 个缺失
    const omitted: number[] = []
    for (let i = 0; i < 10000; i += 40) omitted.push(i)
    const { dataset, report } = parseShmooCsv(makeCsv(100, 100, omitted), {
      fileName: 'grid-100x100-missing.csv'
    })
    const data = dataset as ShmooDataset
    expect(data.sites[0].knownCount).toBe(9750)
    expect(report.missingRatio).toBeCloseTo(250 / 10000, 6)
  })
})

describe('刻度标签抽稀：按像素密度决定标几个', () => {
  /**
   * 断言抽稀结果本身：首尾必留、相邻间距不小于 minGap（数据区不够宽时允许只剩首尾）。
   * 返回实际间距供调用方做更细的断言。
   */
  function assertThinned(positions: number[], minGap: number): number[] {
    const picked = pickTickIndices(positions, minGap)
    expect(picked.length).toBeGreaterThan(0)
    expect(picked[0]).toBe(0)
    expect(picked[picked.length - 1]).toBe(positions.length - 1)
    if (picked.length === 1) return []
    const gaps: number[] = []
    for (let i = 1; i < picked.length; i++) {
      const gap = positions[picked[i]] - positions[picked[i - 1]]
      gaps.push(gap)
      // 首尾被强制保留时，最后一对可能小于 minGap；其余必须满足间距
      if (i < picked.length - 1) expect(gap).toBeGreaterThanOrEqual(minGap - 1e-9)
    }
    return gaps
  }

  it('30×30：x 轴标签数量受 36px 间距约束，首尾保留', () => {
    const geometry = geometryOf(parseGrid(30, 30))
    const xCenters = geometry.x.edges.slice(0, -1).map((edge, ix) => {
      const rect = cellRect(geometry, ix, 0)
      return edge + rect.w / 2
    })
    const picked = pickTickIndices(xCenters, X_MIN_GAP)
    expect(picked.length).toBeLessThan(30)
    expect(picked.length).toBeGreaterThanOrEqual(2)
    assertThinned(xCenters, X_MIN_GAP)
  })

  it('100×100：密集轴显著抽稀（标签数 ≈ 可用宽度 / 间距）', () => {
    const dataset = parseGrid(100, 100)
    const geometry = geometryOf(dataset)
    const xCenters = geometry.x.edges.slice(0, -1).map((edge, ix) => {
      const rect = cellRect(geometry, ix, 0)
      return edge + rect.w / 2
    })
    const picked = pickTickIndices(xCenters, X_MIN_GAP)
    // 800px 宽、数据区 628px → 最多约 628/36 ≈ 17 个标签，远少于 100
    expect(picked.length).toBeLessThanOrEqual(Math.floor(geometry.plot.w / X_MIN_GAP) + 1)
    expect(picked.length).toBeLessThan(25)
    expect(picked[0]).toBe(0)
    expect(picked[picked.length - 1]).toBe(99)
    assertThinned(xCenters, X_MIN_GAP)
  })

  it('1×30 / 30×1：退化的另一轴只有 1 个标签，密集轴正常抽稀', () => {
    const column = geometryOf(parseGrid(1, 30))
    // 单列：x 轴只有一个采样点，位置数组长度为 1
    expect(column.x.edges).toHaveLength(2)
    expect(pickTickIndices([column.plot.x + column.plot.w / 2], X_MIN_GAP)).toEqual([0])

    const row = geometryOf(parseGrid(30, 1))
    const yCenters = row.y.edges.slice(0, -1).map((edge, iy) => {
      const rect = cellRect(row, 0, iy)
      return edge + rect.h / 2
    })
    expect(yCenters).toHaveLength(1)
    expect(pickTickIndices(yCenters, Y_MIN_GAP)).toEqual([0])
  })

  it('y 轴 100 行：按 28px 行间距抽稀，首尾保留', () => {
    const geometry = geometryOf(parseGrid(100, 100))
    // 与 render2d 一致：先按屏幕 y 升序排列再抽稀
    const yCenters = geometry.y.edges
      .slice(0, -1)
      .map((edge, iy) => {
        const rect = cellRect(geometry, 0, iy)
        return edge + rect.h / 2
      })
      .sort((a, b) => a - b)
    const picked = pickTickIndices(yCenters, Y_MIN_GAP)
    expect(picked.length).toBeLessThanOrEqual(Math.floor(geometry.plot.h / Y_MIN_GAP) + 1)
    expect(picked.length).toBeLessThan(40)
    expect(picked[0]).toBe(0)
    expect(picked[picked.length - 1]).toBe(99)
    assertThinned(yCenters, Y_MIN_GAP)
  })
})
