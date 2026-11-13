/**
 * 矢量 PDF 导出测试（阶段 ⑦）。
 *
 * 覆盖用户验收项中可自动化的部分：
 *  - 文字可选中、可搜索：用 pdfjs-dist（第三方解析器，不是 pdfkit 自己）把 PDF 拆回文本；
 *  - 中文字体已嵌入：字节里存在 /FontFile2，且中文能原样提取；
 *  - 标签无重叠、无裁切、无溢出页面：既断言绘制时的审计框，也用 pdfjs 的
 *    实际文字位置做“真实几何”二次断言（审计框可能自报，pdfjs 不会配合我们作弊）；
 *  - 纯矢量：pdfjs 的绘制指令里没有任何图片（噪点 / vignette 不会进 PDF）；
 *  - 2D / 1D 色带 / 1D 曲线 / pattern 二值都能导出；
 *  - 不自造批次信息：CSV 没有 lot/wafer 时，页面上不出现这两个词。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseShmooCsv } from '@shared/csv/parser'
import type { ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import { buildPdfBuffer, findOverlappingBoxes } from '../src/main/export/pdf'
import { A4_LANDSCAPE, boxInsidePage } from '../src/main/export/layout'
import { buildPdfRequest } from '../src/renderer/export/request'

const ROOT = process.cwd()

/** 嵌入字体只读一次（2.1MB），避免每个用例重复读盘 */
const FONT = new Uint8Array(readFileSync(join(ROOT, 'assets/fonts/NotoSansSC-Subset.ttf')))

/** 固定时间，保证页脚文案可断言 */
const AT = new Date(2026, 10, 13, 15, 30, 5).getTime()

function loadSample(name: string): ShmooDataset {
  return parseShmooCsv(readFileSync(join(ROOT, 'samples', name), 'utf8'), { fileName: name }).dataset!
}

/** pdfjs 文本项（坐标已换算成“左上角原点，y 向下”，与 layout.ts 同口径） */
interface TextItem {
  str: string
  x: number
  top: number
  w: number
  h: number
}

interface ParsedPdf {
  pageCount: number
  /** 每页的文本项（已过滤空白） */
  pages: TextItem[][]
  /** 每页的绘制指令名（用于确认没有图片） */
  ops: string[][]
}

/**
 * 用 pdfjs-dist 解析 PDF（第三方实现，避免“自己生成自己验证”）。
 * legacy build 可在 Node 下直接跑，不需要 worker。
 */
async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  // pdfjs 的 ESM 类型声明与 Node 动态导入不完全兼容，这里按 any 使用
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    // 必须复制一份：pdfjs 会把传入的 ArrayBuffer 转移（detach）走，
    // 后续还要用同一份字节做 /FontFile2 等文本断言。
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false
  }).promise
  const pages: TextItem[][] = []
  const ops: string[][] = []
  const OPS = pdfjs.OPS
  // 反查“操作码 → 名字”，方便断言时直接看语义
  const opNames = new Map<number, string>()
  for (const [name, code] of Object.entries(OPS)) opNames.set(code as number, name)
  const imageOps = new Set(['paintImageXObject', 'paintJpegXObject', 'paintImageMaskXObject'])

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const [, , , pageHeight] = page.view // [x0, y0, x1, y1]
    const content = await page.getTextContent()
    const items: TextItem[] = []
    for (const item of content.items as any[]) {
      if (!item.str || item.str.trim().length === 0) continue
      // pdfjs 的 transform 是文本矩阵：[a, b, c, d, e, f]。
      // a/b 是基线方向，c/d 是法线方向（含字号缩放与旋转）；
      // width 是沿基线的长度。旋转 90° 的 y 轴标题必须按向量算 AABB，
      // 不能简单拿 x/width 当水平框，否则会误报“与刻度重叠”。
      const [a, b, c, d, e, f] = item.transform as number[]
      const baseLen = Math.hypot(a, b) || 1
      const normLen = Math.hypot(c, d) || Math.abs(item.height) || 0
      const ux = a / baseLen
      const uy = b / baseLen
      const vx = c / baseLen || 0
      const vy = d / baseLen || 0
      const len = item.width || 0
      const xs = [e, e + ux * len, e + vx * normLen, e + ux * len + vx * normLen]
      const ys = [f, f + uy * len, f + vy * normLen, f + uy * len + vy * normLen]
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      items.push({
        str: item.str,
        x: minX,
        // pdfjs 的 y 是基线（自页面底部算），换算成“顶部”并向下
        top: pageHeight - maxY,
        w: maxX - minX,
        h: maxY - minY
      })
    }
    pages.push(items)

    const list = await page.getOperatorList()
    const names: string[] = []
    for (const fn of list.fnArray as number[]) {
      const name = opNames.get(fn) ?? String(fn)
      if (imageOps.has(name)) names.push(name)
    }
    ops.push(names)
  }
  return { pageCount: doc.numPages, pages, ops }
}

/** 把一页的文本拼成一个字符串，便于“可搜索”断言 */
function pageText(pdf: ParsedPdf, pageIndex: number): string {
  return pdf.pages[pageIndex].map((item) => item.str).join('')
}

/** 两两检查同一页的文字项是否重叠（0.5pt 容差，允许边界刚好接触） */
function findItemOverlaps(items: TextItem[], gap = 0.5): Array<[TextItem, TextItem]> {
  const overlaps: Array<[TextItem, TextItem]> = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (
        a.x < b.x + b.w + gap &&
        b.x < a.x + a.w + gap &&
        a.top < b.top + b.h + gap &&
        b.top < a.top + a.h + gap
      ) {
        overlaps.push([a, b])
      }
    }
  }
  return overlaps
}

/** 构造任意尺寸的合成 2D 数据集：用于 30×30 与 100×100 的文件体积对比 */
function makeGridDataset(size: number): ShmooDataset {
  const axisValues = Array.from({ length: size }, (_, i) => Number((1 + i * 0.01).toFixed(2)))
  const nx = size
  const ny = size
  const value = new Float32Array(nx * ny)
  const pass = new Uint8Array(nx * ny)
  let min = Infinity
  let max = -Infinity
  let passCount = 0
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      // 有明确通过/失败分界的斜坡：保证两种颜色都出现，且 margin 有明显差异
      const v = 800 + ix * 2 - iy
      const index = iy * nx + ix
      value[index] = v
      pass[index] = v >= 820 ? 1 : 0
      if (pass[index] === 1) passCount++
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  const site: SiteGrid = {
    siteId: 'S1',
    siteLabel: 'SITE_1',
    value,
    pass,
    valueRange: { min, max },
    knownCount: nx * ny,
    passCount
  }
  return {
    id: 'synthetic',
    fileName: `synthetic-${size}x${size}.csv`,
    filePath: null,
    importedAt: AT,
    kind: '2d',
    // 故意不带 lot / wafer：用来验证导出不会自造批次信息
    meta: {},
    title: `Synthetic ${size} x ${size}`,
    valueLabel: 'VOH',
    valueUnit: 'mV',
    xAxis: { key: 'x', label: 'VDD', unit: 'V', values: axisValues, scale: 'linear' },
    yAxis: { key: 'y', label: 'PERIOD', unit: 'ns', values: axisValues, scale: 'linear' },
    sites: [site],
    valueType: 'measured',
    passSource: 'derived',
    spec: { mode: 'min', min: 820 },
    issues: [],
    revision: 0
  }
}

describe('PDF：2D 全部站点 + 汇总页', () => {
  // 生成一次，多个断言复用（生成约几十毫秒）
  let pdfPromise: Promise<{ bytes: Uint8Array; audit: any }> | null = null
  const getPdf = () => {
    if (!pdfPromise) {
      const dataset = loadSample('sample-2d-mcu.csv')
      const request = buildPdfRequest(dataset, dataset.sites[0], {
        allSites: true,
        includeSummary: true,
        colorMode: 'binary',
        oneDForm: 'band',
        generatedAt: AT
      })
      pdfPromise = buildPdfBuffer(request, FONT)
    }
    return pdfPromise
  }

  it('页数 = 汇总页 1 + 站点数，PDF 头合法', async () => {
    const { bytes, audit } = await getPdf()
    const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1')
    expect(head).toBe('%PDF-')
    expect(audit.pageCount).toBe(5)
    const pdf = await parsePdf(bytes)
    expect(pdf.pageCount).toBe(5)
  })

  it('文字可提取、可搜索：标题、站点、spec 与通过率都在', async () => {
    const { bytes } = await getPdf()
    const pdf = await parsePdf(bytes)
    const all = pdf.pages.map((_, i) => pageText(pdf, i)).join('\n')
    expect(all).toContain('VDD x PERIOD Shmoo')
    expect(all).toContain('SITE_A')
    expect(all).toContain('SITE_D')
    expect(all).toContain('≥') // 数学符号必须是真字形，不是方框
    expect(all).toContain('spec 推导')
    expect(all).toContain('43.6%') // 汇总页的通过率
  })

  it('中文字体已嵌入（/FontFile2），中文能原样提取', async () => {
    const { bytes } = await getPdf()
    const latin = Buffer.from(bytes).toString('latin1')
    expect(latin).toContain('/FontFile2')
    const pdf = await parsePdf(bytes)
    expect(pageText(pdf, 1)).toContain('判定')
  })

  it('纯矢量：绘制指令里没有任何图片（噪点/vignette 不进 PDF）', async () => {
    const { bytes } = await getPdf()
    const pdf = await parsePdf(bytes)
    for (const names of pdf.ops) expect(names).toEqual([])
    const latin = Buffer.from(bytes).toString('latin1')
    expect(latin).not.toContain('/Subtype /Image')
    expect(latin).not.toContain('/Subtype/Image')
  })

  it('审计框：刻度标签互不重叠，所有文字都在页面内', async () => {
    const { audit } = await getPdf()
    expect(findOverlappingBoxes(audit.boxes)).toEqual([])
    const outside = audit.boxes.filter((box: any) => !boxInsidePage(box))
    expect(outside.map((box: any) => `${box.kind}:${box.text}`)).toEqual([])
  })

  it('真实几何（pdfjs 实测）：页内无溢出、任意两个文字项不重叠', async () => {
    const { bytes } = await getPdf()
    const pdf = await parsePdf(bytes)
    for (const [pageIndex, items] of pdf.pages.entries()) {
      for (const item of items) {
        expect(item.x).toBeGreaterThanOrEqual(-0.5)
        expect(item.x + item.w).toBeLessThanOrEqual(A4_LANDSCAPE.width + 0.5)
        expect(item.top).toBeGreaterThanOrEqual(-0.5)
        expect(item.top + item.h).toBeLessThanOrEqual(A4_LANDSCAPE.height + 0.5)
      }
      const overlaps = findItemOverlaps(items)
      expect(
        overlaps.map(([a, b]) => `p${pageIndex + 1}: "${a.str}" × "${b.str}"`)
      ).toEqual([])
    }
  })

  it('审计宽度与 pdfjs 实测宽度一致（证明度量来自真实字体）', async () => {
    const { bytes, audit } = await getPdf()
    const pdf = await parsePdf(bytes)
    // 取第 2 页（SITE_A 图表页）的 x 轴刻度做对照
    const auditTicks = audit.boxes.filter(
      (box: any) => box.page === 2 && box.kind === 'tick-x'
    ) as any[]
    expect(auditTicks.length).toBeGreaterThan(5)
    const items = pdf.pages[1]
    for (const tick of auditTicks.slice(0, 8)) {
      const hit = items.find((item) => item.str === tick.text)
      expect(hit, `pdfjs 应能提取刻度 ${tick.text}`).toBeTruthy()
      expect(Math.abs((hit as TextItem).w - tick.w)).toBeLessThan(1.5)
    }
  })

  it('页脚：生成时间 + 源文件名；页眉副标题含当前 site', async () => {
    const { bytes } = await getPdf()
    const pdf = await parsePdf(bytes)
    const chartPage = pageText(pdf, 1)
    expect(chartPage).toContain('2026-11-13 15:30:05')
    expect(chartPage).toContain('sample-2d-mcu.csv')
    expect(chartPage).toContain('SITE_A')
  })

  it('不自造批次号：CSV 没有 lot/wafer 的合成数据集不显示这两个词', async () => {
    const dataset = makeGridDataset(8)
    const request = buildPdfRequest(dataset, dataset.sites[0], {
      allSites: false,
      includeSummary: true,
      colorMode: 'binary',
      oneDForm: 'band',
      generatedAt: AT
    })
    const { bytes } = await buildPdfBuffer(request, FONT)
    const pdf = await parsePdf(bytes)
    const all = pdf.pages.map((_, i) => pageText(pdf, i)).join('\n')
    expect(all).not.toMatch(/Lot|Wafer|批次|晶圆/i)
  })
})

describe('PDF：1D 与 pattern', () => {
  it('1D 色带单页导出：窗口文案、边界标签、无重叠', async () => {
    const dataset = loadSample('sample-1d-vdd.csv')
    const request = buildPdfRequest(dataset, dataset.sites[0], {
      allSites: false,
      includeSummary: false,
      colorMode: 'binary',
      oneDForm: 'band',
      generatedAt: AT
    })
    const { bytes, audit } = await buildPdfBuffer(request, FONT)
    expect(audit.pageCount).toBe(1)
    expect(findOverlappingBoxes(audit.boxes)).toEqual([])
    const pdf = await parsePdf(bytes)
    expect(pageText(pdf, 0)).toContain('PASS 窗口')
    // 1D 没有 y 轴，因此不应出现 y 轴刻度框
    expect(audit.boxes.filter((box) => box.kind === 'tick-y')).toEqual([])
  })

  it('1D 曲线形态也能导出，且同样无重叠', async () => {
    const dataset = loadSample('sample-1d-vdd.csv')
    const request = buildPdfRequest(dataset, dataset.sites[0], {
      allSites: false,
      includeSummary: false,
      colorMode: 'binary',
      oneDForm: 'curve',
      generatedAt: AT
    })
    const { bytes, audit } = await buildPdfBuffer(request, FONT)
    expect(audit.pageCount).toBe(1)
    expect(findOverlappingBoxes(audit.boxes)).toEqual([])
    const pdf = await parsePdf(bytes)
    expect(pageText(pdf, 0)).toContain('VDD Margin Sweep')
    expect(audit.boxes.some((box) => box.kind === 'tick-y')).toBe(true)
  })

  it('pattern 二值数据：仍标注为二值判定，且无重叠', async () => {
    const dataset = loadSample('sample-2d-pattern.csv')
    const request = buildPdfRequest(dataset, dataset.sites[0], {
      allSites: false,
      includeSummary: false,
      // 故意传 heat：buildPdfRequest 应把它强制回 binary
      colorMode: 'heat',
      oneDForm: 'band',
      generatedAt: AT
    })
    const { bytes, audit } = await buildPdfBuffer(request, FONT)
    expect(findOverlappingBoxes(audit.boxes)).toEqual([])
    const pdf = await parsePdf(bytes)
    const text = pageText(pdf, 0)
    expect(text).toContain('二值判定')
    expect(text).toContain('二值')
  })
})

describe('PDF：文件体积（30×30 vs 100×100）', () => {
  it('一万个矢量矩形的体积可接受，并输出实测数据', async () => {
    const build = async (size: number) => {
      const dataset = makeGridDataset(size)
      const request = buildPdfRequest(dataset, dataset.sites[0], {
        allSites: false,
        includeSummary: false,
        colorMode: 'binary',
        oneDForm: 'band',
        generatedAt: AT
      })
      const { bytes, audit } = await buildPdfBuffer(request, FONT)
      return { bytes: bytes.length, boxes: audit.boxes.length }
    }
    const small = await build(30)
    const large = await build(100)
    // 实测数据打印到测试日志，报告里直接引用
    console.log(
      `[stage7] 30×30 = ${(small.bytes / 1024).toFixed(1)} KB，` +
        `100×100 = ${(large.bytes / 1024).toFixed(1)} KB`
    )
    expect(large.bytes).toBeGreaterThan(small.bytes)
    // 一万个圆角矩形 + 两轴刻度仍应保持在“可邮件发送”的量级
    expect(large.bytes).toBeLessThan(20 * 1024 * 1024)
  })
})
