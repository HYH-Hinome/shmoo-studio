import { beforeEach, describe, expect, it, vi } from 'vitest'

// 拖放导入必须复用同一条解析链路：这里把 Worker 入口替换成桩，
// 用来断言“拖入有效 CSV 后确实走到了统一解析流程”，而不是另起一套逻辑。
vi.mock('../src/renderer/lib/parseCsv', () => ({
  parseCsvInWorker: vi.fn(async () => ({
    dataset: null,
    report: {
      fileName: 'fake.csv',
      fileSize: 10,
      parseMs: 1,
      totalRows: 1,
      validRows: 0,
      skippedRows: 1,
      duplicateRows: 0,
      sitePointCounts: {},
      missingRatio: 1,
      issues: [{ level: 'error', message: '模拟解析失败' }]
    }
  }))
}))

import { DROP_MAX_BYTES, pickDroppedCsv } from '../src/renderer/lib/fileDrop'
import { parseCsvInWorker } from '../src/renderer/lib/parseCsv'
import { useAppStore } from '../src/renderer/state/store'

/** 只含 name / size 的假文件，够 pickDroppedCsv 使用 */
const file = (name: string, size = 1024): { name: string; size: number } => ({ name, size })

describe('pickDroppedCsv（拖放校验）', () => {
  it('没有文件时给出“没有检测到文件”的提示', () => {
    expect(pickDroppedCsv([]).ok).toBe(false)
    expect(pickDroppedCsv(null).ok).toBe(false)
    const result = pickDroppedCsv(undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('没有检测到文件')
  })

  it('接受 .csv / .txt，扩展名大小写不敏感', () => {
    expect(pickDroppedCsv([file('a.csv')]).ok).toBe(true)
    expect(pickDroppedCsv([file('A.CSV')]).ok).toBe(true)
    expect(pickDroppedCsv([file('data.txt')]).ok).toBe(true)
  })

  it('非 CSV 文件被拒绝，提示里带上文件名和允许的格式', () => {
    const result = pickDroppedCsv([file('report.xlsx')])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('report.xlsx')
      expect(result.message).toContain('.csv')
    }
  })

  it('超过 20MB 被拒绝，恰好 20MB 仍然接受', () => {
    const tooBig = pickDroppedCsv([file('big.csv', DROP_MAX_BYTES + 1)])
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) expect(tooBig.message).toContain('文件过大')
    expect(pickDroppedCsv([file('edge.csv', DROP_MAX_BYTES)]).ok).toBe(true)
  })
})

describe('openDroppedFiles（store 行为）', () => {
  beforeEach(() => {
    useAppStore.setState({ error: null, statusText: '就绪', isParsing: false, fileName: null })
    vi.mocked(parseCsvInWorker).mockClear()
  })

  it('拖入非 CSV：只提示错误，不进入解析流程', async () => {
    await useAppStore.getState().openDroppedFiles([file('note.md') as unknown as File])
    expect(useAppStore.getState().error).toContain('不支持的格式')
    expect(useAppStore.getState().statusText).toBe('拖放未导入')
    expect(useAppStore.getState().isParsing).toBe(false)
    expect(parseCsvInWorker).not.toHaveBeenCalled()
  })

  it('拖入 CSV：读取文本后走统一解析链路（Worker）', async () => {
    const dropped = {
      name: 'dropped.csv',
      size: 12,
      text: async () => 'x,y,value\n1,2,800\n'
    } as unknown as File

    await useAppStore.getState().openDroppedFiles([dropped])

    expect(parseCsvInWorker).toHaveBeenCalledTimes(1)
    // 统一链路会把解析结果写回 store：桩返回致命错误，因此应落到“导入失败”
    expect(useAppStore.getState().isParsing).toBe(false)
    expect(useAppStore.getState().statusText).toBe('导入失败')
    expect(useAppStore.getState().error).toBe('模拟解析失败')
  })
})
