// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ShmooDataset } from '@shared/types/shmoo'
import { computePassRate, parseShmooCsv } from '@shared/csv/parser'
import { applySpecToDataset, isSameSpec } from '@shared/spec/apply'
import { isFlatBinaryDataset, isMarginMeaningful } from '@shared/spec/evaluate'
import { parseSpecInput } from '@shared/spec/input'
import { findPassRuns, findRunBoundaries } from '@renderer/chart/oneD'
import { computeBoxStats, normalizeBox } from '@renderer/chart/interaction'
import { formatSigned } from '@renderer/lib/format'
import { ChartStage } from '@renderer/components/ChartStage'
import { SpecPanel } from '@renderer/components/SpecPanel'
import { StatusBar } from '@renderer/components/StatusBar'
import { useAppStore } from '@renderer/state/store'

/**
 * 阶段 ⑥ 验收测试：spec 实时编辑与不重新解析的重算。
 *
 * 覆盖：
 *  - 界面重算 == 用新 spec 重新解析同一份 CSV（2D / 1D / pattern / pass_source=file）；
 *  - 非法输入拒绝与提示；
 *  - 1D 双边编辑后的色带分段与曲线越界标记；
 *  - 修改 spec 后锁定浮层、框选统计、规格面板同步更新；
 *  - 重置 / 撤销。
 */

const SAMPLE_2D = readFileSync(resolve(process.cwd(), 'samples/sample-2d-mcu.csv'), 'utf8')
const SAMPLE_1D = readFileSync(resolve(process.cwd(), 'samples/sample-1d-vdd.csv'), 'utf8')
const SAMPLE_PATTERN = readFileSync(resolve(process.cwd(), 'samples/sample-2d-pattern.csv'), 'utf8')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 把 CSV 里的 spec 行替换成新值，模拟“用新 spec 重新解析同一份文件” */
function replaceSpec(csv: string, specLine: string): string {
  return csv.replace(/^#\s*spec:.*$/m, `# spec: ${specLine}`)
}

/** 逐 site 对比两份数据集的判定结果，任何一格不同都算不一致 */
function expectSamePass(a: ShmooDataset, b: ShmooDataset): void {
  expect(a.sites.length).toBe(b.sites.length)
  for (let i = 0; i < a.sites.length; i++) {
    expect(Array.from(a.sites[i].pass)).toEqual(Array.from(b.sites[i].pass))
    expect(a.sites[i].passCount).toBe(b.sites[i].passCount)
    expect(a.sites[i].knownCount).toBe(b.sites[i].knownCount)
  }
  expect(computePassRate(a)).toBeCloseTo(computePassRate(b) ?? 0, 10)
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = []

/** 渲染图表 + 规格面板 + 状态栏，返回 HTML */
function renderAll(): string {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <>
        <ChartStage />
        <SpecPanel />
        <StatusBar />
      </>
    )
  })
  mounted.push({ root, container })
  return container.innerHTML
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('spec 输入校验', () => {
  it('支持只填下限、只填上限、双边与 min == max', () => {
    expect(parseSpecInput('720', '')).toEqual({ ok: true, spec: { mode: 'min', min: 720 } })
    expect(parseSpecInput('', '860')).toEqual({ ok: true, spec: { mode: 'max', max: 860 } })
    expect(parseSpecInput('740', '860')).toEqual({
      ok: true,
      spec: { mode: 'window', min: 740, max: 860 }
    })
    expect(parseSpecInput('1', '1')).toEqual({
      ok: true,
      spec: { mode: 'window', min: 1, max: 1 }
    })
  })

  it('拒绝两边都空 / 非数字 / min > max，并给出原因', () => {
    expect(parseSpecInput('', '')).toMatchObject({ ok: false, error: '请至少填写下限或上限' })
    expect(parseSpecInput('abc', '')).toMatchObject({ ok: false, error: '下限必须是数字' })
    expect(parseSpecInput('720', 'Infinity')).toMatchObject({ ok: false, error: '上限必须是数字' })
    expect(parseSpecInput('900', '800')).toMatchObject({ ok: false, error: '下限不能大于上限' })
  })
})

describe('界面重算与重新解析结果一致', () => {
  it('2D 30×30×4：应用 min=740,max=860 与重新解析一致', () => {
    const spec = { mode: 'window' as const, min: 740, max: 860 }
    const a = parseShmooCsv(SAMPLE_2D, { fileName: 'a.csv' }).dataset as ShmooDataset
    const b = parseShmooCsv(replaceSpec(SAMPLE_2D, 'min=740,max=860'), {
      fileName: 'b.csv'
    }).dataset as ShmooDataset
    const c = applySpecToDataset(a, spec)
    expectSamePass(c, b)
    // 数据本身与缺测数不得被 spec 编辑改变
    for (let i = 0; i < a.sites.length; i++) {
      expect(Array.from(c.sites[i].value)).toEqual(Array.from(a.sites[i].value))
      expect(c.sites[i].knownCount).toBe(a.sites[i].knownCount)
    }
    expect(c.revision).toBe(a.revision + 1)
  })

  it('1D：应用 min=780,max=840 与重新解析一致', () => {
    const a = parseShmooCsv(SAMPLE_1D, { fileName: 'a.csv' }).dataset as ShmooDataset
    const b = parseShmooCsv(replaceSpec(SAMPLE_1D, 'min=780,max=840'), {
      fileName: 'b.csv'
    }).dataset as ShmooDataset
    const c = applySpecToDataset(a, { mode: 'window', min: 780, max: 840 })
    expectSamePass(c, b)
  })

  it('pattern（min == max）：改成 min=0,max=0 后与重新解析一致', () => {
    const a = parseShmooCsv(SAMPLE_PATTERN, { fileName: 'a.csv' }).dataset as ShmooDataset
    const b = parseShmooCsv(replaceSpec(SAMPLE_PATTERN, 'min=0,max=0'), {
      fileName: 'b.csv'
    }).dataset as ShmooDataset
    const c = applySpecToDataset(a, { mode: 'window', min: 0, max: 0 })
    expectSamePass(c, b)
    // 仍是纯二值数据：没有连续 margin，图例仍应走“二值判定”
    expect(isFlatBinaryDataset(c)).toBe(true)
    expect(isMarginMeaningful(c)).toBe(false)
  })

  it('pass_source=file：文件 pass 列保持，空值按新 spec 回填，与重新解析一致', () => {
    const csv = [
      '# kind: 2d',
      '# x_label: VDD',
      '# y_label: PERIOD',
      '# value_label: VOH',
      '# value_unit: mV',
      '# value_type: measured',
      '# pass_source: file',
      '# spec: min=700',
      'x,y,site,value,pass',
      '1,1,1,650,FAIL',
      '2,1,1,750,PASS',
      '3,1,1,800,',
      '1,2,1,650,',
      '2,2,1,850,PASS',
      '3,2,1,780,'
    ].join('\n')
    const a = parseShmooCsv(csv, { fileName: 'a.csv' }).dataset as ShmooDataset
    const b = parseShmooCsv(replaceSpec(csv, 'min=760'), { fileName: 'b.csv' })
      .dataset as ShmooDataset
    const c = applySpecToDataset(a, { mode: 'min', min: 760 })
    expectSamePass(c, b)
  })
})

describe('1D 双边编辑：色带分段与曲线越界标记', () => {
  const csv = [
    '# kind: 1d',
    '# x_label: VDD',
    '# x_unit: V',
    '# value_label: VOH',
    '# value_unit: mV',
    '# spec: min=720,max=860',
    'x,site,value',
    '0.60,1,700',
    '0.65,1,750',
    '0.70,1,800',
    '0.75,1,850',
    '0.80,1,900'
  ].join('\n')

  it('收窄为 780–820 后只剩中间一段 PASS，边界角色标记低压/高压两侧', () => {
    const dataset = parseShmooCsv(csv, { fileName: 'band.csv' }).dataset as ShmooDataset
    const next = applySpecToDataset(dataset, { mode: 'window', min: 780, max: 820 })
    const site = next.sites[0]
    const axis = next.xAxis.values

    // 红-绿-红：只有 800 那一点 PASS
    expect(Array.from(site.pass)).toEqual([0, 0, 1, 0, 0])
    const runs = findPassRuns(axis, site.pass)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ startIndex: 2, endIndex: 2, startX: 0.7, endX: 0.7 })

    const boundaries = findRunBoundaries(axis, site.value, site.pass, runs[0], next.spec)
    expect(boundaries.map((b) => b.role)).toEqual([
      'below-min',
      'recover-low',
      'recover-high',
      'above-max'
    ])
    expect(boundaries.map((b) => b.value)).toEqual([0.65, 0.7, 0.7, 0.75])
  })
})

describe('修改 spec 后锁定格 / 框选统计 / 面板同步更新', () => {
  const { dataset, report } = parseShmooCsv(SAMPLE_2D, { fileName: 'sample-2d-mcu.csv' })
  const base = dataset as ShmooDataset

  it('锁定浮层、规格面板、框选统计都反映新判定', () => {
    const site = base.sites[0]
    const nx = base.xAxis.values.length
    // 找一个有值的格子作为锁定格
    const index = site.value.findIndex((v) => Number.isFinite(v))
    const ix = index % nx
    const iy = Math.floor(index / nx)
    const value = site.value[index]
    // 把下限抬到所有值之上：全部已知点必然变 FAIL，便于断言
    let maxValue = Number.NEGATIVE_INFINITY
    for (const s of base.sites) {
      for (const v of s.value) if (Number.isFinite(v) && v > maxValue) maxValue = v
    }
    const nextSpec = { mode: 'min' as const, min: maxValue + 1 }

    act(() => {
      useAppStore.setState({
        dataset: base,
        report,
        spec: base.spec,
        fileSpec: base.spec,
        specHistory: [],
        activeSiteId: site.siteId,
        selection: { ix, iy },
        box: { anchor: { ix: 0, iy: 0 }, focus: { ix: 4, iy: 4 } }
      })
      useAppStore.getState().applySpec(nextSpec)
    })

    // 锁定与框选不应因判定变化被清掉
    const state = useAppStore.getState()
    expect(state.selection).toEqual({ ix, iy })
    expect(state.box).not.toBeNull()

    const html = renderAll()
    // 图表标题里的 spec 文案立即更新
    expect(html).toContain(`VOH ≥ ${nextSpec.min} mV`)
    // 框选期间浮层让位（阶段 ⑤ 的既有规则），先断言框选统计
    const boxStats = computeBoxStats(
      site,
      nx,
      normalizeBox(state.box!.anchor, state.box!.focus),
      nextSpec
    )
    expect(boxStats.pass).toBe(0)
    expect(html).toContain('data-box-stats="1"')
    expect(html).toContain('PASS <span class="mono">0</span>')
    expect(html).toContain(`区域通过率 <span class="mono">${boxStats.passRate === null ? '—' : '0.0%'}</span>`)

    // 清掉框选（保留锁定）后，浮层应显示新判定为 FAIL 与新的 margin
    act(() => useAppStore.getState().setBox(null))
    const lockedHtml = renderAll()
    expect(lockedHtml).toContain('chart-tip__state--fail')
    expect(lockedHtml).toContain('FAIL')
    const expectedMargin = value - nextSpec.min
    expect(lockedHtml).toContain(formatSigned(expectedMargin))
  })

  it('非法输入被拒绝：提示原因且 store 里的 spec 不变', () => {
    act(() => {
      useAppStore.setState({
        dataset: base,
        report,
        spec: base.spec,
        fileSpec: base.spec,
        specHistory: [],
        activeSiteId: base.sites[0].siteId,
        selection: null,
        box: null
      })
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<SpecPanel />)
    })
    mounted.push({ root, container })

    const input = container.querySelector<HTMLInputElement>('[data-spec-min]')
    expect(input).not.toBeNull()
    // 绕过 React 的受控 value 缓存，按真实用户输入路径派发 input 事件
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, 'abc')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.querySelector('[data-spec-error]')?.textContent).toContain('下限必须是数字')
    expect(useAppStore.getState().spec).toEqual(base.spec)
    // 输入框本身保留用户原文，不静默改回默认值
    expect(input?.value).toBe('abc')
  })

  it('重置为文件值 / 撤销上一步可以恢复 spec', () => {
    act(() => {
      useAppStore.setState({
        dataset: base,
        report,
        spec: base.spec,
        fileSpec: base.spec,
        specHistory: [],
        activeSiteId: base.sites[0].siteId,
        selection: null,
        box: null
      })
    })
    const store = useAppStore.getState()
    const edited = { mode: 'window' as const, min: 800, max: 820 }
    act(() => store.applySpec(edited))
    expect(useAppStore.getState().spec).toMatchObject(edited)

    act(() => useAppStore.getState().undoSpec())
    expect(isSameSpec(useAppStore.getState().spec, base.spec)).toBe(true)
    expect(isSameSpec(useAppStore.getState().dataset!.spec, base.spec)).toBe(true)

    act(() => useAppStore.getState().applySpec(edited))
    act(() => useAppStore.getState().resetSpec())
    expect(isSameSpec(useAppStore.getState().spec, base.spec)).toBe(true)
    expect(useAppStore.getState().dataset!.revision).toBeGreaterThan(0)
  })
})
