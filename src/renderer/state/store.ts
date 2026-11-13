import { create } from 'zustand'
import type { ImportReport, ShmooDataset, SpecLimit } from '@shared/types/shmoo'
import { applySpecToDataset, isSameSpec } from '@shared/spec/apply'
import { parseCsvInWorker } from '../lib/parseCsv'
import { pickDroppedCsv } from '../lib/fileDrop'
import type { SliceAxis, SliceRef } from '../chart/slice'
import type { BoxSelection } from '../chart/interaction'
import type { CellIndex } from '../chart/geometry'

/** 默认 spec：未导入数据时使用；导入后会由 CSV 元数据覆盖（D1：全局共用一份） */
export const DEFAULT_SPEC: SpecLimit = { mode: 'min', min: undefined, max: undefined }

/** 2D 图表配色模式：二值（pass/fail）或热力（连续测量值） */
export type ColorMode = 'binary' | 'heat'

/** 1D 图表形态：二值色带或连续曲线（阶段 ④） */
export type OneDForm = 'band' | 'curve'

/** 当前数据集的网格尺寸（1D 视为 ny = 1，避免两套口径） */
function gridSize(dataset: ShmooDataset | null): { nx: number; ny: number } {
  if (!dataset) return { nx: 0, ny: 0 }
  return {
    nx: dataset.xAxis.values.length,
    ny: dataset.yAxis ? dataset.yAxis.values.length : 1
  }
}

/** 格子索引是否落在当前数据集的网格内（用于挡住越界锁定） */
function isValidCell(dataset: ShmooDataset | null, cell: CellIndex): boolean {
  const { nx, ny } = gridSize(dataset)
  return cell.ix >= 0 && cell.ix < nx && cell.iy >= 0 && cell.iy < ny
}

/**
 * 把某个方向的下标夹进合法范围 [0, limit-1]。
 * 切片切换方向时只对“该方向自己的一维”做夹取，绝不拿另一维的下标来兜底，
 * 否则又会出现“列号沿用行号”的问题。limit <= 0 由调用方提前拦截。
 */
function clampSliceIndex(value: number, limit: number): number {
  return Math.max(0, Math.min(value, limit - 1))
}

interface AppState {
  /** 当前数据集；未导入或导入失败时为 null */
  dataset: ShmooDataset | null
  /** 当前选中的站点 id；一个 site 一张图（D2） */
  activeSiteId: string | null
  /** 全局共用 spec（D1），所有 site 同步 */
  spec: SpecLimit
  /** 导入时 CSV 里声明的原始 spec（阶段 ⑥「重置为文件值」使用） */
  fileSpec: SpecLimit | null
  /** spec 修改历史（阶段 ⑥ 一步撤销）：保存被替换掉的旧 spec，最多 20 条 */
  specHistory: SpecLimit[]
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
  /**
   * 导出对话框当前选中的格式（阶段 ⑦）。
   * null 表示关闭；菜单命令与工具栏按钮都只改这个字段，对话框本身由 App 渲染。
   */
  exportFormat: 'png' | 'pdf' | null
  /** 最近一次错误（读取失败、致命解析错误等），展示在状态栏 */
  error: string | null
  /**
   * 锁定读数（阶段 ⑤）：单击锁定某个格子后，浮层常显、不随鼠标移动消失。
   * 只保存索引；像素位置每次由几何实时算出，窗口尺寸变化不会让锁定失效。
   */
  selection: CellIndex | null
  /** 框选范围（阶段 ⑤）：拖拽或 Shift+方向键产生的矩形区域；null 表示没有框选 */
  box: BoxSelection | null
  appVersion: string
  platform: string

  /** 打开 CSV：读取（主进程）→ 解析（Worker）→ 写入 store */
  openCsv: () => Promise<void>
  /**
   * 统一的 CSV 载入流程：按钮 / Ctrl+O / 菜单 / 拖放导入最终都走这里。
   * 入参是“已经拿到文本”的来源信息，解析仍然由同一个 Worker 完成，
   * 这样任何入口都不会出现第二套解析逻辑。
   */
  loadCsvSource: (source: { name: string; text: string; path: string | null }) => Promise<void>
  /**
   * 拖放导入：先校验拖入的文件（必须恰好是 .csv / .txt 且不超过大小上限），
   * 再读取文本交给 loadCsvSource。校验失败时只提示、不进入解析流程。
   */
  openDroppedFiles: (files: ArrayLike<File>) => Promise<void>
  /** 读取应用版本与平台信息 */
  loadAppInfo: () => Promise<void>
  setActiveSite: (siteId: string) => void
  /**
   * 阶段 ⑥：应用新 spec —— 重算所有 site 的 pass / passCount 并刷新派生数据。
   * 不会重新解析 CSV，也不会清空锁定 / 框选（格子索引不变）。
   * 传进来的 spec 必须已经通过 parseSpecInput 校验。
   */
  applySpec: (spec: SpecLimit) => void
  /** 恢复成 CSV 文件里声明的 spec（可被再次撤销） */
  resetSpec: () => void
  /** 撤销上一步 spec 修改；没有历史时什么都不做 */
  undoSpec: () => void
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
  /**
   * 锁定 / 切换锁定格。
   * - 传入与当前锁定相同的格子 → 解除锁定；
   * - 传入不同格子 → 切换锁定目标；
   * - 越界索引直接忽略（防止切换站点后残留指向不存在的格子）。
   */
  toggleSelection: (cell: CellIndex) => void
  /** 直接设置锁定格（null 解除）；越界索引按解除处理，绝不保存非法坐标 */
  setSelection: (cell: CellIndex | null) => void
  /** 直接设置框选范围（null 清除）；端点越界会被夹到网格内 */
  setBox: (box: BoxSelection | null) => void
  /** 清掉锁定与框选（Esc 使用） */
  clearInteraction: () => void
  setDataset: (dataset: ShmooDataset | null) => void
  /** 打开导出对话框（'png' / 'pdf'）；传 null 关闭 */
  openExportDialog: (format: 'png' | 'pdf' | null) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  dataset: null,
  activeSiteId: null,
  spec: DEFAULT_SPEC,
  fileSpec: null,
  specHistory: [],
  colorMode: 'binary',
  oneDForm: 'band',
  ambientMotion: false,
  slice: null,
  sliceMarker: null,
  fileName: null,
  report: null,
  isParsing: false,
  statusText: '就绪 · 尚未导入数据',
  exportFormat: null,
  error: null,
  selection: null,
  box: null,
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
      // 对话框与拖放共用同一条载入流程，避免出现两套解析逻辑
      await get().loadCsvSource({ name: file.name, text: file.text, path: file.path })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: `导入失败：${message}`, statusText: '导入失败', isParsing: false })
    }
  },

  /**
   * 统一的载入流程：拿到文件名 + 文本后，交给 Worker 解析并写入 store。
   * 调用方负责置 isParsing（这样各入口可以有自己的状态文案）。
   */
  loadCsvSource: async (source) => {
    set({ fileName: source.name, statusText: '正在解析 CSV…' })

    try {
      // 解析放在 Web Worker：大文件不会卡住界面（Electron 推荐做法）
      const { dataset, report } = await parseCsvInWorker({
        text: source.text,
        fileName: source.name,
        filePath: source.path
      })

      if (!dataset) {
        // 致命错误（缺列、无数据、measured 但 value 全空等）：保留报告供排错，不写入数据集
        const fatal = report.issues.find((issue) => issue.level === 'error')
        set({
          dataset: null,
          report,
          activeSiteId: null,
          fileSpec: null,
          specHistory: [],
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
        // 记下文件里的原始 spec，供「重置为文件值」使用；历史清空
        fileSpec: dataset.spec,
        specHistory: [],
        isParsing: false,
        statusText: `已导入 ${dataset.fileName} · ${dataset.kind.toUpperCase()} · ${dataset.sites.length} site`,
        error: null,
        // 新数据集与旧切片无关：一并清空，避免下标指向别的数据
        slice: null,
        sliceMarker: null,
        // 锁定/框选同样属于旧数据集，必须清掉
        selection: null,
        box: null
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: `导入失败：${message}`, statusText: '导入失败', isParsing: false })
    }
  },

  openDroppedFiles: async (files) => {
    const picked = pickDroppedCsv(files)
    if (!picked.ok) {
      // 拖进来的不是 CSV（或根本没有文件）：明确提示，保持当前数据集不变
      set({ error: picked.message, statusText: '拖放未导入' })
      return
    }
    if (get().isParsing) return
    set({ error: null, isParsing: true, statusText: `正在读取 ${picked.file.name}…` })
    try {
      // 拖入的文件由 Chromium 以 File 对象提供，直接读文本；
      // 解析仍走 loadCsvSource → Worker，和按钮导入完全一致
      const text = await picked.file.text()
      await get().loadCsvSource({ name: picked.file.name, text, path: null })
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

  // 切换站点意味着整张图的数值都换了：锁定格与框选区域不再可信，必须重置，
  // 否则浮层会停在一个“新站点里同名但不同数据”的格子上（看起来像缓存了旧读数）。
  setActiveSite: (siteId) => set({ activeSiteId: siteId, selection: null, box: null }),

  /**
   * 应用新 spec（阶段 ⑥）。
   * - spec 没变化时只同步 store 字段，不写历史、不 bump revision；
   * - 有变化时：重算所有 site → 替换 dataset → 旧 spec 入历史。
   *   锁定格 / 框选保持不动：格子坐标没有变，只是判定数字变了。
   */
  applySpec: (nextSpec) => {
    const { dataset, specHistory } = get()
    if (!dataset) {
      set({ spec: nextSpec })
      return
    }
    // 相同 spec 反复输入（防抖结束仍相同）不应该制造无意义的历史
    if (isSameSpec(dataset.spec, nextSpec)) {
      set({ spec: dataset.spec })
      return
    }
    const nextDataset = applySpecToDataset(dataset, nextSpec)
    set({
      dataset: nextDataset,
      spec: nextDataset.spec,
      // 只保留最近 20 步，避免长时间拖动滑杆时无限增长
      specHistory: [...specHistory, dataset.spec].slice(-20)
    })
  },

  resetSpec: () => {
    const { fileSpec } = get()
    if (!fileSpec) return
    get().applySpec(fileSpec)
  },

  undoSpec: () => {
    const { dataset, specHistory } = get()
    if (!dataset || specHistory.length === 0) return
    const previous = specHistory[specHistory.length - 1]
    const nextDataset = applySpecToDataset(dataset, previous)
    set({
      dataset: nextDataset,
      spec: nextDataset.spec,
      specHistory: specHistory.slice(0, -1)
    })
  },

  setColorMode: (mode) => set({ colorMode: mode }),
  setOneDForm: (form) => set({ oneDForm: form }),
  setAmbientMotion: (enabled) => set({ ambientMotion: enabled }),

  openSlice: (ref) => {
    const { dataset } = get()
    // 只有 2D 数据集才能切行/列；1D 本身就是一条曲线，不需要切片
    if (!dataset || dataset.kind !== '2d' || !dataset.yAxis) return
    const nx = dataset.xAxis.values.length
    const ny = dataset.yAxis.values.length
    if (nx <= 0 || ny <= 0) return
    // 双击格的两个下标分别夹进各自的轴范围：行用 y、列用 x，
    // 越界时各自夹到最后一行 / 最后一列，互不覆盖
    const x = clampSliceIndex(ref.x, nx)
    const y = clampSliceIndex(ref.y, ny)
    // 当前方向真正生效的下标：行方向 = 双击格的行号(y)，列方向 = 双击格的列号(x)
    const index = ref.axis === 'row' ? y : x
    // 进入切片后 2D 不再显示：锁定与框选一并清掉（返回时从干净状态开始）
    set({
      slice: { axis: ref.axis, index, x, y },
      sliceMarker: { axis: ref.axis, index, x, y },
      selection: null,
      box: null
    })
  },

  setSliceAxis: (axis) => {
    const { dataset, slice } = get()
    if (!dataset || dataset.kind !== '2d' || !dataset.yAxis || !slice) return
    const nx = dataset.xAxis.values.length
    const ny = dataset.yAxis.values.length
    if (nx <= 0 || ny <= 0) return
    // 记住的两个下标各自夹取后再按新方向取值：
    // 切到列方向用的是双击格的 x（列号），不再把行号当列号；
    // 来回切换时 x / y 都原样保留，只是 axis 和 index 在变
    const x = clampSliceIndex(slice.x, nx)
    const y = clampSliceIndex(slice.y, ny)
    const index = axis === 'row' ? y : x
    set({ slice: { axis, index, x, y }, sliceMarker: { axis, index, x, y } })
  },

  closeSlice: () => set({ slice: null }),

  clearSliceMarker: () => set({ sliceMarker: null }),

  toggleSelection: (cell) => {
    const { dataset, selection } = get()
    // 越界索引直接忽略：切换站点/数据集后即使有残留调用也不会锁到不存在的格子
    if (!isValidCell(dataset, cell)) {
      set({ selection: null })
      return
    }
    // 同一格再次单击 = 解除锁定；不同格 = 切换锁定目标
    const same = selection && selection.ix === cell.ix && selection.iy === cell.iy
    set({ selection: same ? null : { ix: cell.ix, iy: cell.iy } })
  },

  setSelection: (cell) => {
    const { dataset } = get()
    if (!cell || !isValidCell(dataset, cell)) {
      set({ selection: null })
      return
    }
    set({ selection: { ix: cell.ix, iy: cell.iy } })
  },

  setBox: (box) => {
    const { dataset } = get()
    if (!box) {
      set({ box: null })
      return
    }
    const { nx, ny } = gridSize(dataset)
    if (nx <= 0 || ny <= 0) {
      set({ box: null })
      return
    }
    const anchor = {
      ix: Math.max(0, Math.min(nx - 1, box.anchor.ix)),
      iy: Math.max(0, Math.min(ny - 1, box.anchor.iy))
    }
    const focus = {
      ix: Math.max(0, Math.min(nx - 1, box.focus.ix)),
      iy: Math.max(0, Math.min(ny - 1, box.focus.iy))
    }
    set({ box: { anchor, focus } })
  },

  clearInteraction: () => set({ selection: null, box: null }),

  setDataset: (dataset) =>
    set({
      dataset,
      activeSiteId: dataset?.sites[0]?.siteId ?? null,
      spec: dataset?.spec ?? DEFAULT_SPEC,
      // 外部直接换数据集（样例 / 测试）时同样重置 spec 基线
      fileSpec: dataset?.spec ?? null,
      specHistory: [],
      // 换数据集后旧的切片下标可能越界，直接清空，避免指到别的数据上
      slice: null,
      sliceMarker: null,
      // 锁定与框选同样属于旧数据集的坐标，必须清空
      selection: null,
      box: null
    }),

  // 导出对话框只保存“打开的是哪种格式”，具体的选项（倍数 / 全部 site / 汇总页）
  // 都是对话框内的临时状态，关闭即丢弃，不需要进全局 store。
  openExportDialog: (format) => set({ exportFormat: format })
}))
