import { create } from 'zustand'
import type { ImportReport, ShmooDataset, SpecLimit } from '@shared/types/shmoo'
import { parseCsvInWorker } from '../lib/parseCsv'

/** 默认 spec：未导入数据时使用；导入后会由 CSV 元数据覆盖（D1：全局共用一份） */
export const DEFAULT_SPEC: SpecLimit = { mode: 'min', min: undefined, max: undefined }

interface AppState {
  /** 当前数据集；未导入或导入失败时为 null */
  dataset: ShmooDataset | null
  /** 当前选中的站点 id；一个 site 一张图（D2） */
  activeSiteId: string | null
  /** 全局共用 spec（D1），所有 site 同步 */
  spec: SpecLimit
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
  setDataset: (dataset: ShmooDataset | null) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  dataset: null,
  activeSiteId: null,
  spec: DEFAULT_SPEC,
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
        error: null
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
  setDataset: (dataset) =>
    set({
      dataset,
      activeSiteId: dataset?.sites[0]?.siteId ?? null,
      spec: dataset?.spec ?? DEFAULT_SPEC
    })
}))
