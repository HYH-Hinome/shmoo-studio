/// <reference types="vite/client" />

import type { ShmooApi } from '@shared/types/api'
import type { ShmooDataset, SiteGrid } from '@shared/types/shmoo'
import type { ChartBench, ChartPerf } from '@renderer/chart/perf'

declare global {
  interface Window {
    /** preload 暴露的白名单 API，见 src/shared/types/api.ts */
    shmoo: ShmooApi
    /** 仅开发模式：图表各层绘制耗时采样（阶段 ③ 验收实测用） */
    __shmooPerf?: ChartPerf
    /** 仅开发模式：1920×1080@DPR2 静态层压测结果（?demo=1&bench=1） */
    __shmooBench?: ChartBench
    /** 仅开发模式：演示数据集，供像素自检脚本核对渲染结果 */
    __shmooDemo?: { dataset: ShmooDataset; site: SiteGrid }
    /** 仅开发模式：zustand store 本体，供切片/悬停等状态自检读取 */
    __shmooStore?: typeof import('./state/store').useAppStore
  }
}

export {}
