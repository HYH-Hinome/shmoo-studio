/**
 * PNG 导出测试（阶段 ⑦）。
 *
 * 这里用 @napi-rs/canvas 提供一个与浏览器 Canvas 同 API 的离屏画布，
 * 直接执行渲染进程的导出函数（renderExportCanvas）。
 * 断言重点：
 *  - 像素尺寸 = CSS 尺寸 × 缩放倍数（高度含标题区）；
 *  - 背景是不透明实色（不能是透明底，否则贴进文档会变黑）；
 *  - 随机抽样格子中心颜色与当前调色板一致（噪点带来的偏差在容差内）；
 *  - 2× 与 3× 同一点的取色一致（放大不改变配色）；
 *  - pattern 二值数据使用饱和的 PASS/FAIL 套色，而不是二值边缘色；
 *  - 生成的 PNG 字节有合法文件头与 IHDR 尺寸（文件能正常打开）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { GlobalFonts, Path2D as NapiPath2D, createCanvas } from '@napi-rs/canvas'
import { parseShmooCsv } from '@shared/csv/parser'
import type { ShmooDataset } from '@shared/types/shmoo'
import {
  BINARY_PALETTE,
  binaryMarginColor,
  CHART_STRUCTURE,
  computeMarginTints,
  hexToRgb,
  PASSFAIL_PALETTE,
  passFailColor
} from '../src/renderer/chart/colors'
import {
  cellRect,
  computeGeometry,
  DEFAULT_PADDING,
  type ChartPadding
} from '../src/renderer/chart/geometry'
import { renderExportCanvas, PNG_HEADER_HEIGHT, computePngPixelSize } from '../src/renderer/export/png'

const ROOT = process.cwd()

/** 测试画布尺寸（CSS px），与界面上常见的图表区尺寸接近 */
const CSS_W = 720
const CSS_H = 440

/** 抽样容差：噪点最大 17/255 的白色叠加，留一点余量 */
const COLOR_TOLERANCE = 26

beforeAll(() => {
  // render2d 的噪点纹理通过 document.createElement('canvas') 生成，
  // Node 下用 napi 画布补上这两个全局对象。
  ;(globalThis as any).Path2D = NapiPath2D
  ;(globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`未实现的元素：${tag}`)
      return createCanvas(96, 96)
    }
  }
  // 让中文标题 / 刻度在测试画布上也能真实测量（缺失时退回默认字体，不影响颜色断言）。
  // 字体路径不写死：优先读环境变量 SHMOO_TEST_FONTS（目录列表，Windows 用分号、
  // macOS/Linux 用冒号分隔），未设置时在 Windows 上回落到系统字体目录；
  // 其他平台找不到字体文件就跳过，测试仍可通过。
  const fontDirs = [
    ...(process.env.SHMOO_TEST_FONTS ?? '').split(delimiter),
    process.platform === 'win32' ? 'C:\\Windows\\Fonts' : ''
  ].filter(Boolean)
  for (const dir of fontDirs) {
    for (const [file, family] of [
      ['msyh.ttc', 'Microsoft YaHei'],
      ['consola.ttf', 'Consolas']
    ] as const) {
      const fontPath = join(dir, file)
      if (!existsSync(fontPath)) continue
      try {
        GlobalFonts.registerFromPath(fontPath, family)
      } catch {
        // 字体文件损坏或格式不支持时静默跳过：颜色断言不依赖字形
      }
    }
  }
})

function loadSample(name: string): ShmooDataset {
  return parseShmooCsv(readFileSync(join(ROOT, 'samples', name), 'utf8'), { fileName: name }).dataset!
}

/** 与 png.ts 内部一致的 padding（顶部多留标题区） */
const PADDING: ChartPadding = { ...DEFAULT_PADDING, top: DEFAULT_PADDING.top + PNG_HEADER_HEIGHT }

/** 导出一张 2D 画布并返回取色工具 */
function render2d(dataset: ShmooDataset, siteIndex: number, scale: 2 | 3, flatBinary: boolean) {
  const site = dataset.sites[siteIndex]
  // 纯二值数据集的 margin tint 为 null，此时测试不取 tint（抽样只看平涂色）
  const tint = computeMarginTints(site, dataset.spec) ?? new Float32Array(0)
  const canvas = renderExportCanvas(
    {
      dataset,
      site,
      mode: 'binary',
      form: 'band',
      flatBinary,
      tint,
      width: CSS_W,
      height: CSS_H,
      scale
    },
    { subtitle: 'SITE_A · spec 测试' },
    // 工厂返回 napi 画布；renderExportCanvas 会自己设置 width/height
    () => createCanvas(1, 1) as any
  )
  const ctx = (canvas as any).getContext('2d')
  const totalH = CSS_H + PNG_HEADER_HEIGHT
  const geometry = computeGeometry(CSS_W, totalH, PADDING, dataset.xAxis.values, dataset.yAxis!.values)
  const nx = dataset.xAxis.values.length

  /**
   * 取某格内的颜色（CSS 坐标 × scale）。
   *
   * 采样点取格子高度的 30% 处而不是正中心：@napi-rs/canvas（Skia）在“最底行”
   * 格子中心会多画一条 1px 伪影线（真实 Chromium 没有，已用 Electron 导出比对确认）。
   * 取上 1/3 处既避开该测试环境差异，又仍在色块纯色区（顶部 1px 高光之下）。
   */
  const sampleCell = (ix: number, iy: number) => {
    const rect = cellRect(geometry, ix, iy)
    const px = Math.round((rect.x + rect.w / 2) * scale)
    const py = Math.round((rect.y + rect.h * 0.3) * scale)
    return Array.from(ctx.getImageData(px, py, 1, 1).data) as number[]
  }

  /** 取任意 CSS 坐标的颜色 */
  const sampleCss = (x: number, y: number) => {
    return Array.from(
      ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data
    ) as number[]
  }

  return { canvas, ctx, tint, nx, sampleCell, sampleCss }
}

/** 从调色板字符串解析出 rgb，便于与像素比较 */
function rgbOf(color: string): [number, number, number] {
  if (color.startsWith('#')) return hexToRgb(color)
  const match = color.match(/rgba?\(([^)]+)\)/)
  if (!match) throw new Error(`无法解析颜色：${color}`)
  const parts = match[1].split(',').map((v) => Number(v.trim()))
  return [parts[0], parts[1], parts[2]]
}

function expectNear(actual: number[], expected: [number, number, number], label: string): void {
  for (let i = 0; i < 3; i++) {
    expect(
      Math.abs(actual[i] - expected[i]),
      `${label} 通道 ${i}：实际 ${actual[i]}，期望 ${expected[i]}（±${COLOR_TOLERANCE}）`
    ).toBeLessThanOrEqual(COLOR_TOLERANCE)
  }
}

describe('PNG：2D 二值导出', () => {
  const dataset = loadSample('sample-2d-mcu.csv')
  const site = dataset.sites[0]

  it('像素尺寸 = CSS × 缩放，高度含标题区', () => {
    const two = render2d(dataset, 0, 2, false)
    expect((two.canvas as any).width).toBe(CSS_W * 2)
    expect((two.canvas as any).height).toBe((CSS_H + PNG_HEADER_HEIGHT) * 2)
    expect(computePngPixelSize(CSS_W, CSS_H, 3)).toEqual({
      width: CSS_W * 3,
      height: (CSS_H + PNG_HEADER_HEIGHT) * 3
    })
  })

  it('背景是画布底色的不透明实色（不是透明底）', () => {
    const { sampleCss } = render2d(dataset, 0, 2, false)
    const corner = sampleCss(1, 1)
    expect(corner[3]).toBe(255)
    expectNear(corner, hexToRgb(CHART_STRUCTURE.canvasBg), '画布背景')
  })

  it('随机抽样格子中心颜色与调色板一致（含 margin 明度调制）', () => {
    const { sampleCell, tint, nx } = render2d(dataset, 0, 2, false)
    const candidates: Array<[number, number]> = []
    // 取分布在不同区域、且非缺失的点位
    for (const [ix, iy] of [
      [1, 1],
      [5, 10],
      [12, 20],
      [28, 3],
      [20, 28]
    ] as Array<[number, number]>) {
      const index = iy * nx + ix
      if (site.pass[index] !== 2 && site.pass[index] !== undefined) candidates.push([ix, iy])
    }
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    for (const [ix, iy] of candidates) {
      const index = iy * nx + ix
      const expected = rgbOf(binaryMarginColor(site.pass[index], tint[index]))
      expectNear(sampleCell(ix, iy), expected, `格子 (${ix},${iy})`)
    }
  })

  it('2× 与 3× 同一点取色一致，放大不改变配色', () => {
    const two = render2d(dataset, 0, 2, false)
    const three = render2d(dataset, 0, 3, false)
    for (const [ix, iy] of [
      [2, 2],
      [15, 15],
      [26, 8]
    ] as Array<[number, number]>) {
      const a = two.sampleCell(ix, iy)
      const b = three.sampleCell(ix, iy)
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(COLOR_TOLERANCE)
      }
    }
  })

  it('标题区确实画了文字（不是一片纯底色）', () => {
    const { ctx } = render2d(dataset, 0, 2, false)
    const data = ctx.getImageData(0, 0, CSS_W * 2, PNG_HEADER_HEIGHT * 2).data as Uint8ClampedArray
    let bright = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 80) bright++
    }
    expect(bright).toBeGreaterThan(200)
  })

  it('导出的 PNG 字节有合法文件头，IHDR 尺寸与画布一致', () => {
    const { canvas } = render2d(dataset, 0, 2, false)
    const png = (canvas as any).toBuffer('image/png') as Buffer
    // 89 50 4E 47 = \x89PNG
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    // IHDR 的宽高在固定偏移：8 字节签名 + 4 长度 + 4 类型 + 4 宽 + 4 高
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect(width).toBe(CSS_W * 2)
    expect(height).toBe((CSS_H + PNG_HEADER_HEIGHT) * 2)
  })
})

describe('PNG：pattern 二值数据', () => {
  it('使用饱和的 PASS/FAIL 套色，而不是二值边缘色', () => {
    const dataset = loadSample('sample-2d-pattern.csv')
    const site = dataset.sites[0]
    const { sampleCell, nx } = render2d(dataset, 0, 2, true)

    let passCell: [number, number] | null = null
    let failCell: [number, number] | null = null
    for (let iy = 0; iy < dataset.yAxis!.values.length && (!passCell || !failCell); iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const state = site.pass[iy * nx + ix]
        if (state === 1 && !passCell) passCell = [ix, iy]
        if (state === 0 && !failCell) failCell = [ix, iy]
      }
    }
    expect(passCell).toBeTruthy()
    expect(failCell).toBeTruthy()
    expectNear(sampleCell(...passCell!), rgbOf(PASSFAIL_PALETTE.pass), 'pattern PASS')
    expectNear(sampleCell(...failCell!), rgbOf(PASSFAIL_PALETTE.fail), 'pattern FAIL')
  })

  it('缺失格回到底色而不是红/绿', () => {
    const dataset = loadSample('sample-2d-pattern.csv')
    const site = dataset.sites[0]
    const { sampleCell, nx } = render2d(dataset, 0, 2, true)
    let unknownCell: [number, number] | null = null
    for (let iy = 0; iy < dataset.yAxis!.values.length && !unknownCell; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (site.pass[iy * nx + ix] === 2) {
          unknownCell = [ix, iy]
          break
        }
      }
    }
    // 该样例可能没有缺失点：有才断言（缺失格会叠加斜纹，容差放宽）
    if (unknownCell) {
      expectNear(sampleCell(...unknownCell), rgbOf(BINARY_PALETTE.unknownBase), 'pattern 缺失')
    }
    // 无论是否有缺失点，PASS 的颜色都不应是 unknownBase
    expect(passFailColor(1)).not.toBe(BINARY_PALETTE.unknownBase)
  })
})

describe('PNG：1D 导出', () => {
  it('1D 色带也能导出，尺寸正确且背景不透明', () => {
    const dataset = loadSample('sample-1d-vdd.csv')
    const site = dataset.sites[0]
    const canvas = renderExportCanvas(
      {
        dataset,
        site,
        mode: 'binary',
        form: 'band',
        flatBinary: false,
        width: CSS_W,
        height: CSS_H,
        scale: 2
      },
      { subtitle: 'SITE_A · 1D 色带' },
      () => createCanvas(1, 1) as any
    )
    expect((canvas as any).width).toBe(CSS_W * 2)
    expect((canvas as any).height).toBe((CSS_H + PNG_HEADER_HEIGHT) * 2)
    const ctx = (canvas as any).getContext('2d')
    const corner = Array.from(ctx.getImageData(2, 2, 1, 1).data) as number[]
    expect(corner[3]).toBe(255)
    expectNear(corner, hexToRgb(CHART_STRUCTURE.canvasBg), '1D 背景')
  })
})
