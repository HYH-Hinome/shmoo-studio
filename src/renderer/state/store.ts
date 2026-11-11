import { create } from 'zustand'
import type { ShmooDataset, SpecLimit } from '@shared/types/shmoo'

/** 默认 spec：阶段 ① 仅作为占位，导入数据后会由 CSV 元数据覆盖 */
export const DEFAULT_SPEC: SpecLimit = { mode: 'min', min: undefined, max: undefined }

interface AppState {
  /** 当前数据集；阶段 ① 恒为 null（解析在阶段 ② 接入） */
  dataset: ShmooDataset | null
  /** 当前选中的站点 id；一个 site 一张图（D2） */
  activeSiteId: string | null
  /** 全局共用 spec（D1），所有 site 同步 */
  spec: SpecLimit
  /** 最近读入的文件名，用于左栏与状态栏展示 */
  fileName: string | null
  /** 状态栏文案 */
  statusText: string
  /** 最近一次错误（读取失败等），展示在状态栏右侧 */
  error: string | null
  appVersion: string
  platform: string

  /** 打开 CSV（当前只完成读取，解析/渲染在后续阶段接入） */
  openCsv: () => Promise<void>
  /** 读取应用版本与平台信息 */
  loadAppInfo: () => Promise<void>
  setActiveSite: (siteId: string) => void
  setSpec: (spec: SpecLimit) => void
  setDataset: (dataset: ShmooDataset | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  dataset: null,
  activeSiteId: null,
  spec: DEFAULT_SPEC,
  fileName: null,
  statusText: '就绪 · 尚未导入数据',
  error: null,
  appVersion: '—',
  platform: '—',

  openCsv: async () => {
    set({ error: null, statusText: '正在读取文件…' })
    try {
      const file = await window.shmoo.openCsv()
      if (!file) {
        set({ statusText: '已取消导入' })
        return
      }
      // 阶段 ① 只验证 IPC 与读取链路：显示文件名与字符数，不做解析
      set({
        fileName: file.name,
        statusText: `已读取 ${file.name} · ${file.text.length.toLocaleString('en-US')} 字符（解析将在阶段 ② 接入）`
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: `读取失败：${message}`, statusText: '读取失败' })
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
