import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CELL_FAIL,
  CELL_PASS,
  CELL_UNKNOWN,
  type ShmooDataset
} from '@shared/types/shmoo'
import { computePassRate, parseShmooCsv } from '@shared/csv/parser'
import { ISSUE_CODES } from '@shared/csv/validate'

/**
 * 解析器测试。
 * 断言一律针对“可观察的事实”（点位数、三态分布、issue code、缺失比例），
 * 而不是文案，避免以后改提示语导致测试成片失效。
 */

/** 读取样例文件（路径用 import.meta.url 解析，避免依赖工作目录） */
const SAMPLE_2D = readFileSync(new URL('../samples/sample-2d-mcu.csv', import.meta.url), 'utf8')
const SAMPLE_1D = readFileSync(new URL('../samples/sample-1d-vdd.csv', import.meta.url), 'utf8')

/** 拼一份最小 CSV：meta 行 + 表头 + 数据行 */
function makeCsv(
  rows: string[],
  options: { meta?: string[]; header?: string } = {}
): string {
  return [...(options.meta ?? []), options.header ?? 'x,y,site,pass,value', ...rows].join('\n')
}

/** 从结果里取出某个 issue code 的数量；不存在返回 0 */
function issueCount(dataset: ShmooDataset | null, code: string): number {
  return dataset?.issues.find((issue) => issue.code === code)?.count ?? 0
}

describe('样例基准 · sample-2d-mcu.csv', () => {
  const { dataset, report } = parseShmooCsv(SAMPLE_2D, { fileName: 'sample-2d-mcu.csv' })

  it('识别为 2D，30 × 30 × 4 site 网格', () => {
    expect(dataset).not.toBeNull()
    const data = dataset as ShmooDataset
    expect(data.kind).toBe('2d')
    expect(data.xAxis.values).toHaveLength(30)
    expect(data.yAxis?.values).toHaveLength(30)
    expect(data.sites).toHaveLength(4)
    // 每个 site 的网格长度 = nx * ny
    for (const site of data.sites) expect(site.value.length).toBe(900)
  })

  it('元数据被正确读取（标题 / 轴单位 / 站点显示名 / 全局 spec）', () => {
    const data = dataset as ShmooDataset
    expect(data.title).toContain('VDD x PERIOD Shmoo')
    expect(data.xAxis.unit).toBe('V')
    expect(data.yAxis?.unit).toBe('ns')
    expect(data.valueLabel).toBe('VOH')
    expect(data.valueUnit).toBe('mV')
    expect(data.sites.map((s) => s.siteLabel)).toEqual([
      'SITE_A',
      'SITE_B',
      'SITE_C',
      'SITE_D'
    ])
    // D1：spec 挂在数据集顶层，所有 site 共用
    expect(data.spec).toEqual({ mode: 'min', min: 720 })
    expect(data.passSource).toBe('derived')
  })

  it('3588 个有效点，12 个刻意留空的单元记为缺失而非 fail', () => {
    const data = dataset as ShmooDataset
    expect(report.validRows).toBe(3588)
    expect(report.skippedRows).toBe(0)
    expect(report.duplicateRows).toBe(0)

    const totalKnown = data.sites.reduce((sum, site) => sum + site.knownCount, 0)
    expect(totalKnown).toBe(3588)

    const totalCells = data.sites.reduce((sum, site) => sum + site.value.length, 0)
    expect(totalCells).toBe(3600)
    expect(report.missingRatio).toBeCloseTo(12 / 3600, 6)

    // 缺失单元必须是 UNKNOWN，不能被算成 fail
    let unknown = 0
    for (const site of data.sites) {
      for (let i = 0; i < site.pass.length; i++) {
        if (!Number.isFinite(site.value[i])) {
          expect(site.pass[i]).toBe(CELL_UNKNOWN)
          unknown++
        }
      }
    }
    expect(unknown).toBe(12)
  })

  it('整体通过率落在样例设计的合理区间，且无致命错误', () => {
    const data = dataset as ShmooDataset
    expect(report.issues.some((issue) => issue.level === 'error')).toBe(false)
    const rate = computePassRate(data)
    expect(rate).not.toBeNull()
    expect(rate as number).toBeGreaterThan(0.35)
    expect(rate as number).toBeLessThan(0.65)
  })

  it('解析耗时满足 < 300ms 的性能红线，并打印实测值', () => {
    const started = performance.now()
    const result = parseShmooCsv(SAMPLE_2D, { fileName: 'sample-2d-mcu.csv' })
    const elapsed = performance.now() - started
    console.log(`[perf] sample-2d-mcu.csv 解析 ${elapsed.toFixed(2)} ms（内部计时 ${result.report.parseMs} ms）`)
    expect(result.dataset).not.toBeNull()
    expect(elapsed).toBeLessThan(300)
  })
})

describe('样例基准 · sample-1d-vdd.csv', () => {
  const { dataset, report } = parseShmooCsv(SAMPLE_1D, { fileName: 'sample-1d-vdd.csv' })

  it('识别为 1D，无 y 轴，30 点 × 4 site = 120 个单元', () => {
    const data = dataset as ShmooDataset
    expect(data.kind).toBe('1d')
    expect(data.yAxis).toBeNull()
    expect(data.xAxis.values).toHaveLength(30)
    expect(data.sites).toHaveLength(4)
    expect(report.validRows).toBe(120)
    expect(report.missingRatio).toBe(0)
  })

  it('双边 spec 生效：低压端与高压端 fail，中间 pass', () => {
    const data = dataset as ShmooDataset
    expect(data.spec).toEqual({ mode: 'window', min: 740, max: 860 })

    for (const site of data.sites) {
      // 每个 site 两端都有失效点、中间都有通过点，说明窗口判定确实生效
      expect(site.passCount).toBeGreaterThan(0)
      expect(site.passCount).toBeLessThan(site.knownCount)
    }
    const rate = computePassRate(data) as number
    expect(rate).toBeGreaterThan(0.2)
    expect(rate).toBeLessThan(0.5)
  })

  it('解析耗时满足 < 300ms 的性能红线，并打印实测值', () => {
    const started = performance.now()
    const result = parseShmooCsv(SAMPLE_1D, { fileName: 'sample-1d-vdd.csv' })
    const elapsed = performance.now() - started
    console.log(`[perf] sample-1d-vdd.csv 解析 ${elapsed.toFixed(2)} ms（内部计时 ${result.report.parseMs} ms）`)
    expect(result.dataset).not.toBeNull()
    expect(elapsed).toBeLessThan(300)
  })
})

describe('R1 · BOM / CRLF / 末尾空行归一化', () => {
  it('BOM + CRLF 与 LF 文本解析结果一致', () => {
    const lf = makeCsv(['0.6,1.0,1,1,700', '0.7,1.0,1,1,750'])
    const crlfBom = `\uFEFF${lf.replace(/\n/g, '\r\n')}\r\n\r\n`

    const a = parseShmooCsv(lf, { fileName: 'a.csv' })
    const b = parseShmooCsv(crlfBom, { fileName: 'b.csv' })

    expect(b.dataset?.xAxis.values).toEqual(a.dataset?.xAxis.values)
    expect(b.report.validRows).toBe(a.report.validRows)
    expect(b.report.totalRows).toBe(2)
    // 归一化属于“静默处理”，不应产生任何警告
    expect(b.report.issues).toHaveLength(0)
  })

  it('真实样例转成 CRLF + BOM 后仍是 3588 点', () => {
    const crlf = `\uFEFF${SAMPLE_2D.replace(/\n/g, '\r\n')}`
    const result = parseShmooCsv(crlf, { fileName: 'crlf.csv' })
    expect(result.report.validRows).toBe(3588)
    expect(result.dataset?.sites).toHaveLength(4)
  })
})

describe('R2 · 文件版本', () => {
  it('版本 2.0 继续解析并给 R2 警告', () => {
    const text = makeCsv(['0.6,1.0,1,1,700'], {
      meta: ['#!shmoo-csv 2.0', '# spec: min=720']
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'v2.csv' })
    expect(dataset).not.toBeNull()
    expect(dataset?.issues.map((i) => i.code)).toContain(ISSUE_CODES.FILE_VERSION)
  })
})

describe('R3 / R4 · 致命结构错误', () => {
  it('声明 2D 但缺 y 列 → E100，dataset 为 null', () => {
    const text = makeCsv(['0.6,1,1,700'], {
      meta: ['# kind: 2d', '# spec: min=720'],
      header: 'x,site,pass,value'
    })
    const result = parseShmooCsv(text, { fileName: 'no-y.csv' })
    expect(result.dataset).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(ISSUE_CODES.MISSING_Y)
  })

  it('缺 x 列 → E101', () => {
    const text = makeCsv(['1,0,700'], { header: 'y,site,value' })
    const result = parseShmooCsv(text, { fileName: 'no-x.csv' })
    expect(result.dataset).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(ISSUE_CODES.MISSING_X)
  })

  it('只有表头没有数据行 → E102', () => {
    const text = 'x,y,site,pass,value'
    const result = parseShmooCsv(text, { fileName: 'empty.csv' })
    expect(result.dataset).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(ISSUE_CODES.NO_DATA)
  })

  it('全部数据行都被跳过 → E102（不是静默成功）', () => {
    const text = makeCsv(['bad,1.0,1,1,700'])
    const result = parseShmooCsv(text, { fileName: 'all-bad.csv' })
    expect(result.dataset).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(ISSUE_CODES.NO_DATA)
  })

  it('只有注释、没有表头 → E105', () => {
    const text = ['#!shmoo-csv 1.0', '# title: 只有元数据'].join('\n')
    const result = parseShmooCsv(text, { fileName: 'no-header.csv' })
    expect(result.dataset).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(ISSUE_CODES.NO_HEADER)
  })
})

describe('R5 · 未知列', () => {
  it('忽略未知列但仍给出 R5 警告，且数据完整', () => {
    const text = makeCsv(['0.6,1.0,1,1,700,extra', '0.7,1.0,1,1,760,extra'], {
      meta: ['# spec: min=720'],
      header: 'x,y,site,pass,value,tester_note'
    })
    const { dataset, report } = parseShmooCsv(text, { fileName: 'unknown-col.csv' })
    expect(report.validRows).toBe(2)
    const issue = dataset?.issues.find((i) => i.code === ISSUE_CODES.UNKNOWN_COLUMN)
    expect(issue?.message).toContain('tester_note')
  })
})

describe('R6 · 非法数值', () => {
  it('x / value 非数值的行被跳过并计数，其余正常', () => {
    const text = makeCsv([
      '0.6,1.0,1,1,700',
      'abc,1.0,1,1,700', // x 非法
      '0.7,1.0,1,1,--', // value 非法（空才是合法缺测，"--" 不是）
      '0.8,1.0,1,1,800'
    ], { meta: ['# spec: min=720'] })
    const { dataset, report } = parseShmooCsv(text, { fileName: 'bad-number.csv' })
    expect(report.totalRows).toBe(4)
    expect(report.validRows).toBe(2)
    expect(report.skippedRows).toBe(2)
    expect(issueCount(dataset, ISSUE_CODES.BAD_NUMBER)).toBe(2)
  })
})

describe('R7 · pass 值无法识别', () => {
  it('"OK" 被记为未知而不是猜成 pass/fail', () => {
    // 二值数据（value_type=passfail）才会直接使用 pass 列，正好用来验证 R7 的“不猜”语义
    const text = makeCsv(['0.6,1,OK,700'], {
      meta: ['# value_type: passfail'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'bad-pass.csv' })
    const data = dataset as ShmooDataset
    expect(data.sites[0].pass[0]).toBe(CELL_UNKNOWN)
    expect(data.sites[0].knownCount).toBe(1) // 数值存在，仍算已知点
    expect(issueCount(dataset, ISSUE_CODES.BAD_PASS_TOKEN)).toBe(1)
  })
})

describe('R8 · 重复点', () => {
  const rows = ['0.6,1.0,1,1,700', '0.6,1.0,1,0,600']

  it('默认 last-wins：后一行覆盖前一行', () => {
    const { dataset, report } = parseShmooCsv(
      makeCsv(rows, { meta: ['# value_type: measured', '# spec: min=720'] }),
      { fileName: 'dup-last.csv' }
    )
    expect(report.duplicateRows).toBe(1)
    expect(report.validRows).toBe(1)
    const data = dataset as ShmooDataset
    expect(data.sites[0].value[0]).toBe(600)
    expect(data.sites[0].pass[0]).toBe(CELL_FAIL) // 600 < 720
  })

  it('first-wins 可选：保留首行', () => {
    const { dataset } = parseShmooCsv(
      makeCsv(rows, { meta: ['# value_type: measured', '# spec: min=720'] }),
      { fileName: 'dup-first.csv' },
      { duplicatePolicy: 'first' }
    )
    const data = dataset as ShmooDataset
    expect(data.sites[0].value[0]).toBe(700)
    expect(data.sites[0].pass[0]).toBe(CELL_FAIL) // 700 < 720，说明确实取的首行值
  })
})

describe('R9 · 稀疏网格', () => {
  it('3×3 网格只有 3 个点：缺失比例 6/9，且不报错', () => {
    const text = makeCsv([
      '0.6,1,1,1,700',
      '0.7,2,1,1,750',
      '0.8,3,1,1,800'
    ], { meta: ['# spec: min=720'] })
    const { dataset, report } = parseShmooCsv(text, { fileName: 'sparse.csv' })
    const data = dataset as ShmooDataset
    expect(data.xAxis.values).toHaveLength(3)
    expect(data.yAxis?.values).toHaveLength(3)
    expect(report.missingRatio).toBeCloseTo(6 / 9, 6)
    expect(report.issues.some((i) => i.level === 'error')).toBe(false)
    // 缺失单元是 UNKNOWN，不能污染通过率分母
    expect(data.sites[0].knownCount).toBe(3)
    expect(computePassRate(data)).toBe(1)
  })
})

describe('R10 · 轴范围以实际数据为准', () => {
  it('乱序输入仍按数值升序建轴，刻度不丢', () => {
    const text = makeCsv([
      '0.9,2,1,1,700',
      '0.6,2,1,1,700',
      '0.75,2,1,1,700'
    ], { meta: ['# spec: min=720'] })
    const { dataset } = parseShmooCsv(text, { fileName: 'unsorted.csv' })
    expect(dataset?.xAxis.values).toEqual([0.6, 0.75, 0.9])
  })
})

describe('R11 · 只有一个 site', () => {
  it('单 site 数据可解析，显示名回退为 Site <id>', () => {
    const text = makeCsv(['0.6,1,1,700', '0.7,1,1,760'], {
      meta: ['# spec: min=720'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'single-site.csv' })
    const data = dataset as ShmooDataset
    expect(data.sites).toHaveLength(1)
    expect(data.sites[0].siteLabel).toBe('Site 1')
    expect(data.sites[0].knownCount).toBe(2)
  })
})

describe('R12 · site 数过多', () => {
  it('超过阈值时给 info 提示（阈值可注入，便于测试）', () => {
    const rows = ['0.6,1,1,700', '0.6,2,1,700', '0.6,3,1,700']
    const text = makeCsv(rows, { meta: ['# spec: min=720'], header: 'x,site,pass,value' })
    const { dataset } = parseShmooCsv(text, { fileName: 'many-sites.csv' }, { siteWarnThreshold: 2 })
    expect(dataset?.sites).toHaveLength(3) // 仍然加载
    expect(issueCount(dataset, ISSUE_CODES.MANY_SITES)).toBe(1)
  })
})

describe('R13 · 行数过多', () => {
  it('超过阈值时给 info 提示（阈值可注入）', () => {
    const text = makeCsv(['0.6,1,1,700', '0.7,1,1,700', '0.8,1,1,700'], {
      meta: ['# spec: min=720'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'long.csv' }, { rowWarnThreshold: 2 })
    expect(issueCount(dataset, ISSUE_CODES.LARGE_FILE)).toBe(1)
  })
})

describe('R14 · 疑似非 UTF-8', () => {
  it('大量替换字符触发编码提示，但继续解析', () => {
    const damagedMeta = `# comment: ${'\uFFFD'.repeat(8)}`
    const text = makeCsv(['0.6,1,1,700'], {
      meta: [damagedMeta, '# spec: min=720'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'gbk.csv' })
    expect(dataset).not.toBeNull()
    expect(dataset?.issues.map((i) => i.code)).toContain(ISSUE_CODES.ENCODING)
  })
})

describe('R15 · measured 但 value 全为空', () => {
  it('给 E103 并中止导入（提示检查 value_type）', () => {
    const text = makeCsv(['0.6,1,1,', '0.7,1,1,'], {
      meta: ['# value_type: measured', '# spec: min=720'],
      header: 'x,site,pass,value'
    })
    const result = parseShmooCsv(text, { fileName: 'empty-value.csv' })
    expect(result.dataset).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(ISSUE_CODES.EMPTY_VALUE)
  })
})

describe('R16 · derived 但没有 spec', () => {
  it('所有单元记为未知，通过率为 null，并提示 NO_SPEC', () => {
    const text = makeCsv(['0.6,1,1,700', '0.7,1,1,800'], {
      meta: ['# value_type: measured'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'no-spec.csv' })
    const data = dataset as ShmooDataset
    expect(data.sites[0].value[0]).toBe(700) // 值仍在，只是不判定
    expect(data.sites[0].pass[0]).toBe(CELL_UNKNOWN)
    expect(data.sites[0].passCount).toBe(0)
    expect(computePassRate(data)).toBeNull()
    expect(issueCount(dataset, ISSUE_CODES.NO_SPEC)).toBe(1)
  })
})

describe('R17 · 列数与表头不一致', () => {
  it('坏行被跳过并记录行号，好行保留', () => {
    const text = makeCsv(['0.6,1,1,700', '0.7,1,1', '0.8,1,1,800'], {
      meta: ['# spec: min=720'],
      header: 'x,site,pass,value'
    })
    const { dataset, report } = parseShmooCsv(text, { fileName: 'col-mismatch.csv' })
    expect(report.validRows).toBe(2)
    expect(report.skippedRows).toBe(1)
    const issue = dataset?.issues.find((i) => i.code === ISSUE_CODES.COLUMN_MISMATCH)
    expect(issue?.line).toBe(4) // 1 行 meta + 1 行表头 + 2 行数据 → 第 4 行
  })
})

describe('1D · 缺 y 列', () => {
  it('无 y 列时自动识别 1D，未声明 kind 也成立', () => {
    const text = makeCsv(['0.6,1,1,700', '0.7,2,1,760'], {
      meta: ['# spec: min=720'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'no-y-1d.csv' })
    const data = dataset as ShmooDataset
    expect(data.kind).toBe('1d')
    expect(data.yAxis).toBeNull()
    expect(data.sites).toHaveLength(2)
  })
})

describe('元数据缺失', () => {
  it('完全没有 # 行时仍能解析，标题回退为文件名', () => {
    // 不含 pass 列 → 推断为 measured；没有 spec → 全部未知 + R16 提示
    const text = makeCsv(['0.6,1.0,1,700', '0.7,2.0,1,760'], {
      header: 'x,y,site,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'plain.csv' })
    const data = dataset as ShmooDataset
    expect(data.title).toBe('plain')
    expect(data.kind).toBe('2d')
    expect(data.xAxis.label).toBe('X')
    expect(data.valueLabel).toBe('VALUE')
    expect(data.valueType).toBe('measured')
    expect(data.sites[0].pass[0]).toBe(CELL_UNKNOWN)
    expect(issueCount(dataset, ISSUE_CODES.NO_SPEC)).toBe(1)
  })
})

describe('空行处理', () => {
  it('中间空行与末尾空行都不计入数据行', () => {
    const text = ['# spec: min=720', 'x,site,pass,value', '0.6,1,1,700', '', '  ', '0.7,1,1,760', '', ''].join('\n')
    const { report } = parseShmooCsv(text, { fileName: 'blank.csv' })
    expect(report.totalRows).toBe(2)
    expect(report.skippedRows).toBe(0)
    expect(report.validRows).toBe(2)
  })
})

describe('全空网格', () => {
  it('pass 与 value 全空时得到全未知网格，缺失比例 100%', () => {
    const text = makeCsv(['0.6,1,,', '0.7,1,,', '0.8,1,,'], {
      meta: ['# value_type: passfail'],
      header: 'x,site,pass,value'
    })
    const { dataset, report } = parseShmooCsv(text, { fileName: 'empty-grid.csv' })
    const data = dataset as ShmooDataset
    expect(report.missingRatio).toBe(1)
    expect(data.sites[0].knownCount).toBe(0)
    expect(Array.from(data.sites[0].pass)).toEqual([CELL_UNKNOWN, CELL_UNKNOWN, CELL_UNKNOWN])
    // 缺失不是失败：passCount 必须为 0，不能出现 fail 计数
    expect(data.sites[0].passCount).toBe(0)
    expect(computePassRate(data)).toBeNull()
  })
})

describe('三态语义 · pass 列与判定来源', () => {
  it('value_type=passfail 时以文件 pass 列为准，空值为未知', () => {
    const text = makeCsv(['0.6,1,1,700', '0.7,1,0,700', '0.8,1,,700'], {
      meta: ['# value_type: passfail'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'passfail.csv' })
    const data = dataset as ShmooDataset
    expect(data.valueType).toBe('passfail')
    expect(Array.from(data.sites[0].pass)).toEqual([CELL_PASS, CELL_FAIL, CELL_UNKNOWN])
  })

  it('measured + pass_source=file：文件 pass 优先于 spec 推导', () => {
    const text = makeCsv(['0.6,1,1,700'], {
      meta: ['# value_type: measured', '# spec: min=720', '# pass_source: file'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'pass-file.csv' })
    const data = dataset as ShmooDataset
    expect(data.passSource).toBe('file')
    // 700 低于 spec 720，但文件说 pass，应以文件为准
    expect(data.sites[0].pass[0]).toBe(CELL_PASS)
  })
})

describe('spec 元数据非法', () => {
  it('解析失败降级为 SPEC 警告 + 默认 spec，不中断导入', () => {
    const text = makeCsv(['0.6,1,1,700'], {
      meta: ['# value_type: measured', '# spec: min=abc'],
      header: 'x,site,pass,value'
    })
    const { dataset } = parseShmooCsv(text, { fileName: 'bad-spec.csv' })
    expect(dataset).not.toBeNull()
    expect(dataset?.issues.map((i) => i.code)).toContain(ISSUE_CODES.BAD_SPEC)
    expect(dataset?.sites[0].pass[0]).toBe(CELL_UNKNOWN)
  })
})

describe('E104 · 声明 1D 但 y 变化', () => {
  it('同一份数据里出现多个 y 取值 → 报 E104 并中止', () => {
    const text = makeCsv(['0.6,1.0,1,1,700', '0.7,2.0,1,1,760'], {
      meta: ['# kind: 1d', '# value_type: measured', '# spec: min=720']
    })
    const result = parseShmooCsv(text, { fileName: 'wrong-kind.csv' })
    expect(result.dataset).toBeNull()
    expect(result.issues.map((i) => i.code)).toContain(ISSUE_CODES.INCONSISTENT_1D)
  })
})

describe('computePassRate', () => {
  it('空数据集返回 null，而不是 0 或 NaN', () => {
    expect(computePassRate({ sites: [] } as unknown as ShmooDataset)).toBeNull()
  })
})
