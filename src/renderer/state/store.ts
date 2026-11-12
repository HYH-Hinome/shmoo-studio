import { create } from 'zustand'
import type { ImportReport, ShmooDataset, SpecLimit } from '@shared/types/shmoo'
import { parseCsvInWorker } from '../lib/parseCsv'
import type { SliceAxis, SliceRef } from '../chart/slice'

/** 默认 spec：未导入数据时使用；导入后会由 CSV 元数据覆盖（D1：全局共用一份） */
export const DEFAULT_SPEC: SpecLimit = { mode: 'min', min: undefined, max: undefined }

/** 2D 图表配色模式：二值（pass/fail）或热力（连续测量值） */
export type ColorMode = 'binary' | 'heat'

/** 1D 图表形态：二值色带或连续曲线（阶段 ④） */
export type OneDForm = 'band' | 'curve'

interface AppState {
  /** 当前数据集；未导入或导入失败时为 null */
  dataset: ShmooDataset | null
  /** 当前选中的站点 id；一个 site 一张图（D2） */
  activeSiteId: string | null
  /** 全局共用 spec（D1），所有 site 同步 */
  spec: SpecLimit
  /** 2D 图表配色模式：二值 / 热力（阶段 ③） */
  colorMode: ColorMode
  /** 1D 图表形态：色带 / 曲线（阶段 ④），与 2D 的 colorMode 互不影响 */
  oneDForm: OneDForm
  /** 氛围动效开关（默认关）：开启后边界线会轻微呼吸、图区噪点缓慢流动 */
  ambientMotion: boolean
  /** 当前切片视图（非 null 时中央显示这条 2D 行/列的 1D 曲线） */
  slice: SliceRef | null
  /** 2D 图上的切片标记：返回 2D 后仍然保留，提示“刚才看的是哪一条” */
  sliceMarker: SliceRef | null
  /** 最近读入的文件名，用于左栏与状态栏展示 */
  fileName: string | null
  /** 最近一次导入报告（点数、跳过行、缺失比例、解析耗时、问题列表） */
  report: ImportReport | null
  /** 是否正在读取/解析，用于禁用重复点击 */
  isParsing: boolean
  /** 状态栏文案 */
  statusText: string
  /** 最近一次错误（读取失败、致命解析错误等），展示在状态栏 */
  error: string | null
  appVersion: string
  platform: string

  /** 打开 CSV：读取（主进程）→ 解析（Worker）→ 写入 store */
  openCsv: () => Promise<void>
  /** 读取应用版本与平台信息 */
  loadAppInfo: () => Promise<void>
  setActiveSite: (siteId: string) => void
  setSpec: (spec: SpecLimit) => void
  setColorMode: (mode: ColorMode) => void
  setOneDForm: (form: OneDForm) => void
  /** 开关氛围动效；关闭时立即停掉 rAF 循环，画面回到完全静止 */
  setAmbientMotion: (enabled: boolean) => void
  /** 打开某一行 / 列的切片视图（同时记下 2D 上的标记） */
  openSlice: (ref: SliceRef) => void
  /** 在切片视图里切换行 / 列方向；下标越界时自动夹到合法范围 */
  setSliceAxis: (axis: SliceAxis) => void
  /** 返回 2D 全图；sliceMarker 保留，用于回看定位 */
  closeSlice: () => void
  /** 手动清除 2D 上的切片标记 */
  clearSliceMarker: () => void
  setDataset: (dataset: ShmooDataset | null) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  dataset: null,
  activeSiteId: null,
  spec: DEFAULT_SPEC,
  colorMode: 'binary',
  oneDForm: 'band',
  ambientMotion: false,
  slice: null,
  sliceMarker: null,
  fileName: null,
  report: null,
  isParsing: false,
  statusText: '就绪 · 尚未导入数据',
  error: null,
  appVersion: '—',
  platform: '—',

  openCsv: async () => {
    // 解析未完成时忽略重复触发，避免同时开两个 Worker
    if (get().isParsing) return
    set({ error: null, isParsing: true, statusText: '正在读取文件…' })
    try {
      const file = await window.shmoo.openCsv()
      if (!file) {
        set({ statusText: '已取消导入', isParsing: false })
        return
      }

      set({ fileName: file.name, statusText: '正在解析 CSV…' })

      // 解析放在 Web Worker：大文件不会卡住界面（Electron 推荐做法）
      const { dataset, report } = await parseCsvInWorker({
        text: file.text,
        fileName: file.name,
        filePath: file.path
      })

      if (!dataset) {
        // 致命错误（缺列、无数据、measured 但 value 全空等）：保留报告供排错，不写入数据集
        const fatal = report.issues.find((issue) => issue.level === 'error')
        set({
          dataset: null,
          report,
          activeSiteId: null,
          isParsing: false,
          statusText: '导入失败',
          error: fatal?.message ?? 'CSV 无法解析'
        })
        return
      }

      set({
        dataset,
        report,
        activeSiteId: dataset.sites[0]?.siteId ?? null,
        spec: dataset.spec,
        isParsing: false,
        statusText: `已导入 ${dataset.fileName} · ${dataset.kind.toUpperCase()} · ${dataset.sites.length} site`,
        error: null,
        // 新数据集与旧切片无关：一并清空，避免下标指向别的数据
        slice: null,
        sliceMarker: null
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: `导入失败：${message}`, statusText: '导入失败', isParsing: false })
    }
  },

  loadAppInfo: async () => {
    try {
      const info = await window.shmoo.getAppInfo()
      set({ appVersion: info.version, platform: info.platform })
    } catch {
      // 版本信息获取失败不影响主流程，保持占位即可
      set({ appVersion: 'unknown' })
    }
  },

  setActiveSite: (siteId) => set({ activeSiteId: siteId }),
  setSpec: (spec) => set({ spec }),
  setColorMode: (mode) => set({ colorMode: mode }),
  setOneDForm: (form) => set({ oneDForm: form }),
  setAmbientMotion: (enabled) => set({ ambientMotion: enabled }),

  openSlice: (ref) => {
    const { dataset } = get()
    // 只有 2D 数据集才能切行/列；1D 本身就是一条曲线，不需要切片
    if (!dataset || dataset.kind !== '2d' || !dataset.yAxis) return
    const limit = ref.axis === 'row' ? dataset.yAxis.values.length : dataset.xAxis.values.length
    if (limit <= 0) return
    const index = Math.max(0, Math.min(ref.index, limit - 1))
    set({ slice: { axis: ref.axis, index }, sliceMarker: { axis: ref.axis, index } })
  },

  setSliceAxis: (axis) => {
    const { dataset, slice } = get()
    if (!dataset || dataset.kind !== '2d' || !dataset.yAxis || !slice) return
    // 行号与列号不能直接复用：切换方向时按新轴长度夹紧
    const limit = axis === 'row' ? dataset.yAxis.values.length : dataset.xAxis.values.length
    if (limit <= 0) return
    const index = Math.max(0, Math.min(slice.index, limit - 1))
    set({ slice: { axis, index }, sliceMarker: { axis, index } })
  },

  closeSlice: () => set({ slice: null }),

  clearSliceMarker: () => set({ sliceMarker: null }),

  setDataset: (dataset) =>
    set({
      dataset,
      activeSiteId: dataset?.sites[0]?.siteId ?? null,
      spec: dataset?.spec ?? DEFAULT_SPEC,
      // 换数据集后旧的切片下标可能越界，直接清空，避免指到别的数据上
      slice: null,
      sliceMarker: null
    })
}))
