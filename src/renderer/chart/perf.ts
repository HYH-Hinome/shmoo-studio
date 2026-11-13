/**
 * 图表绘制耗时采样结构（阶段 ③ 验收用）。
 * 只在开发模式下由 Shmoo2DChart 挂到 window.__shmooPerf，
 * 生产构建不会暴露，也不参与任何业务逻辑。
 */
export interface ChartPerf {
  /** 静态层每次绘制的耗时（ms），含入场动画期间的逐帧重绘 */
  static: number[]
  /** 边界层耗时（ms） */
  boundary: number[]
  /** 交互层耗时（ms，hover 移动时每帧一次） */
  interaction: number[]
  /** 静态层累计绘制帧数 */
  frames: number
}

/** 1920×1080 @ DPR2 压测结果（?demo=1&bench=1 时写入 window.__shmooBench） */
export interface ChartBench {
  width: number
  height: number
  dpr: number
  cells: number
  runs: number
  median: number
  p95: number
  max: number
}
