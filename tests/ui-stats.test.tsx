// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ImportReport, ShmooDataset } from '@shared/types/shmoo'
import { computePassRate, parseShmooCsv } from '@shared/csv/parser'
import { evaluatePoint } from '@shared/spec/evaluate'
import { formatCount, formatMs, formatPercent, formatSigned } from '@renderer/lib/format'
import { ChartStage } from '@renderer/components/ChartStage'
import { SiteRail } from '@renderer/components/SiteRail'
import { SpecPanel } from '@renderer/components/SpecPanel'
import { StatusBar } from '@renderer/components/StatusBar'
import { useAppStore } from '@renderer/state/store'

/**
 * 界面接入测试（阶段 ② 验收项 3）。
 *
 * 用 jsdom + react-dom/client 把真实数据集渲染出来，再断言界面上“能看到”的数字。
 * 这样验证的是 store → 组件的真实链路（而不是对着源码做文本搜索），
 * 也不需要启动 Electron 或弹出原生文件对话框。
 */

// jsdom 环境下 import.meta.url 会被改写成 http:// 地址，无法直接读文件，
// 这里用项目根目录（vitest 的 cwd）拼接样例路径
const SAMPLE_2D = readFileSync(resolve(process.cwd(), 'samples/sample-2d-mcu.csv'), 'utf8')
const SAMPLE_1D = readFileSync(resolve(process.cwd(), 'samples/sample-1d-vdd.csv'), 'utf8')

// React 18 的 act 需要这个全局标记，否则会打印 “not wrapped in act” 警告
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 把解析结果灌进 store（模拟 openCsv 成功后的状态），渲染四个主要区域并返回 HTML */
function renderLoaded(dataset: ShmooDataset, report: ImportReport): string {
  useAppStore.setState({
    dataset,
    report,
    spec: dataset.spec,
    fileName: dataset.fileName,
    activeSiteId: dataset.sites[0]?.siteId ?? null,
    statusText: `已导入 ${dataset.fileName} · ${dataset.kind.toUpperCase()} · ${dataset.sites.length} site`,
    error: null
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <>
        <SiteRail />
        <ChartStage />
        <SpecPanel />
        <StatusBar />
      </>
    )
  })
  const html = container.innerHTML
  act(() => root.unmount())
  container.remove()
  return html
}

describe('界面统计 · 2D 样例', () => {
  const { dataset, report } = parseShmooCsv(SAMPLE_2D, { fileName: 'sample-2d-mcu.csv' })
  const data = dataset as ShmooDataset
  const html = renderLoaded(data, report)

  it('状态栏显示真实点数 / site 数 / 通过率 / 缺测 / 解析耗时', () => {
    expect(html).toContain(`点数 <span class="mono">${formatCount(report.validRows)}</span>`)
    expect(html).toContain('3,588') // 样例固定值，防止 formatCount 改坏
    expect(html).toContain(
      `通过率 <span class="mono">${formatPercent(computePassRate(data))}</span>`
    )
    // 3600 个单元中有 12 个刻意留空
    expect(html).toContain('缺测 <span class="mono">12</span>')
    expect(html).toContain(formatMs(report.parseMs))
  })

  it('站点栏渲染数据里真实出现的 site，而不是写死', () => {
    for (const label of ['SITE_A', 'SITE_B', 'SITE_C', 'SITE_D']) {
      expect(html).toContain(label)
    }
    // 4 个站点 = 4 个可点击的切换按钮（只匹配按钮自身的 class，排除 __name / __meta 子元素）
    expect(html.match(/class="site-item[" ]/g) ?? []).toHaveLength(4)
    expect(html).toContain('30 × 30')
  })

  it('图表区显示数据集信息与 spec，且不出现 NaN', () => {
    expect(html).toContain('2D SHMOO')
    expect(html).toContain('VDD x PERIOD Shmoo')
    expect(html).toContain('当前站点')
    expect(html).toContain('VOH ≥ 720 mV')
    expect(html).not.toContain('NaN')
  })

  it('规格面板显示真实通过率与最差 margin', () => {
    expect(html).toContain('规格判定')

    // 按与面板相同的口径算一遍最差 margin，再断言它确实出现在 DOM 里
    let worst: number | null = null
    for (const site of data.sites) {
      for (const value of site.value) {
        if (!Number.isFinite(value)) continue
        const { margin } = evaluatePoint(value, data.spec)
        if (margin === null) continue
        if (worst === null || margin < worst) worst = margin
      }
    }
    expect(worst).not.toBeNull()
    expect(worst as number).toBeLessThan(0) // 样例里存在 fail 点，最差 margin 必为负
    expect(html).toContain(formatSigned(worst as number))
  })
})

describe('界面统计 · 1D 样例', () => {
  const { dataset, report } = parseShmooCsv(SAMPLE_1D, { fileName: 'sample-1d-vdd.csv' })
  const data = dataset as ShmooDataset
  const html = renderLoaded(data, report)

  it('按 1D 渲染：无 y 轴、网格 30 × 1、120 个有效点', () => {
    expect(html).toContain('1D SHMOO')
    expect(html).toContain('30 × 1')
    expect(html).toContain('点数 <span class="mono">120</span>')
    expect(html).toContain('SITE_B')
  })

  it('通过率与缺测数字自洽（1D 样例没有缺失点）', () => {
    expect(html).toContain('缺测 <span class="mono">0</span>')
    expect(html).toContain(formatPercent(computePassRate(data)))
    expect(html).toContain('740 ≤ VOH ≤ 860 mV')
  })
})
