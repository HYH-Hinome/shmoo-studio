/**
 * 导出文案与文件名的纯函数测试（阶段 ⑦）。
 *
 * 这里覆盖三类容易“看起来对、其实会坑人”的细节：
 *  1. 文件名：非法字符清洗、过长截断、时间戳格式、站点缺省时不出现连续下划线；
 *  2. spec 文案：window / min / max / zero-width / none 五种模式各自措辞；
 *  3. 通过率：分母只用已知点，known=0 时显示 “—” 而不是 0%。
 */

import { describe, expect, it } from 'vitest'
import {
  buildExportFileName,
  describePassSource,
  describeSpec,
  formatFileStamp,
  formatPassRate,
  formatReadableTime,
  pickLotMeta,
  sanitizeFileBase
} from '@shared/export/format'
import type { SpecLimit } from '@shared/types/shmoo'

/** 用“本地时间”构造时间戳，避免测试机时区不同导致断言漂移 */
const LOCAL_TIME = new Date(2026, 10, 13, 15, 30, 5).getTime()

describe('formatFileStamp / formatReadableTime', () => {
  it('文件名时间戳为 YYYYMMDD-HHmmss', () => {
    expect(formatFileStamp(LOCAL_TIME)).toBe('20261113-153005')
  })

  it('页脚可读时间为 YYYY-MM-DD HH:mm:ss', () => {
    expect(formatReadableTime(LOCAL_TIME)).toBe('2026-11-13 15:30:05')
  })
})

describe('sanitizeFileBase', () => {
  it('替换 Windows/macOS 非法字符并折叠空白', () => {
    expect(sanitizeFileBase('VDD: 0.6/0.9 * test?')).toBe('VDD 0.6 0.9 test')
  })

  it('空名字退回默认主干，不会产生空文件名', () => {
    expect(sanitizeFileBase('   ')).toBe('shmoo-export')
  })

  it('超长名字截断到 80 字符', () => {
    expect(sanitizeFileBase('长'.repeat(200)).length).toBe(80)
  })
})

describe('buildExportFileName', () => {
  it('包含数据集名 + 站点 + 时间戳 + 扩展名', () => {
    expect(buildExportFileName('VDD x PERIOD Shmoo', 'SITE_A', LOCAL_TIME, 'pdf')).toBe(
      'VDD x PERIOD Shmoo_SITE_A_20261113-153005.pdf'
    )
  })

  it('没有站点时省略中段，不出现连续下划线', () => {
    expect(buildExportFileName('VDD x PERIOD Shmoo', null, LOCAL_TIME, 'png')).toBe(
      'VDD x PERIOD Shmoo_20261113-153005.png'
    )
  })

  it('标题里的非法字符不会带进文件名', () => {
    expect(buildExportFileName('A/B: C', 'SITE|1', LOCAL_TIME, 'png')).toBe(
      'A B C_SITE 1_20261113-153005.png'
    )
  })
})

describe('describeSpec', () => {
  const windowSpec: SpecLimit = { mode: 'window', min: 740, max: 860 }

  it('双边窗口写成 min ≤ V ≤ max 并带单位', () => {
    expect(describeSpec(windowSpec, 'VOH', 'mV')).toBe('740 ≤ VOH ≤ 860 mV')
  })

  it('零宽窗口（min=max）等价于等号，不写成 a ≤ V ≤ a', () => {
    expect(describeSpec({ mode: 'window', min: 1, max: 1 }, 'PASS', '')).toBe('PASS = 1')
  })

  it('单边模式分别使用 ≥ / ≤', () => {
    expect(describeSpec({ mode: 'min', min: 720 }, 'VOH', 'mV')).toBe('VOH ≥ 720 mV')
    expect(describeSpec({ mode: 'max', max: 720 }, 'VOH', 'mV')).toBe('VOH ≤ 720 mV')
  })

  it('none 模式明确写“不参与比较”，未配置写“未配置”，都不伪造数值', () => {
    expect(describeSpec({ mode: 'none' }, 'VOH', 'mV')).toBe('spec: none（不参与比较）')
    expect(describeSpec({ mode: 'window' }, 'VOH', 'mV')).toBe('未配置 spec')
  })

  it('没有单位时不留尾随空格', () => {
    expect(describeSpec({ mode: 'min', min: 1 }, 'PASS', '')).toBe('PASS ≥ 1')
  })
})

describe('describePassSource', () => {
  it('pass 列优先于 spec 推导', () => {
    expect(describePassSource('file', { mode: 'min', min: 1 })).toBe('CSV pass 列')
    expect(describePassSource('derived', { mode: 'min', min: 1 })).toBe('spec 推导')
    expect(describePassSource('derived', { mode: 'none' })).toBe('spec: none')
  })
})

describe('formatPassRate', () => {
  it('分母只用已知点', () => {
    expect(formatPassRate(43, 100)).toBe('43.0%')
    expect(formatPassRate(1, 3)).toBe('33.3%')
  })

  it('known=0 显示破折号，避免误读成 0%', () => {
    expect(formatPassRate(0, 0)).toBe('—')
  })
})

describe('pickLotMeta', () => {
  it('只挑 CSV 里真实存在的批次类键，不补造', () => {
    expect(
      pickLotMeta({ Lot: 'DEMO-2601', Wafer: '03', Operator: 'zzz', '批次': 'B1', '晶圆': '  ' })
    ).toEqual([
      { key: 'Lot', value: 'DEMO-2601' },
      { key: 'Wafer', value: '03' },
      { key: '批次', value: 'B1' }
    ])
  })

  it('没有批次信息时返回空数组', () => {
    expect(pickLotMeta({ Operator: 'zzz' })).toEqual([])
  })
})
