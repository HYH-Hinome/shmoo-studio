/**
 * CSV 文本的底层切分工具：只负责字符层面的归一化，不做任何业务判断。
 * 这些函数保持纯函数，便于在 Vitest 中逐条覆盖 R1（BOM/CRLF）、R17（列数）等规则。
 */

/** 去掉 UTF-8 BOM（R1） */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 统一换行为 \n，并去掉行尾 \r（R1） */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 切分为行，去掉末尾空行（R1：末尾空行不算数据） */
export function splitLines(text: string): string[] {
  const lines = normalizeNewlines(stripBom(text)).split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/** 按逗号切分并 trim 每个字段；不支持引号包裹（规范里已约定值内不允许逗号） */
export function splitFields(line: string): string[] {
  return line.split(',').map((field) => field.trim())
}

/** 是否元数据/注释行（以 # 开头） */
export function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith('#')
}

/** 是否空行 */
export function isBlankLine(line: string): boolean {
  return line.trim() === ''
}

/**
 * 粗判编码问题（R14）：按 UTF-8 解码失败会替换成 U+FFFD，
 * 出现比例较高时提示用户改用 GB18030 重新读取，而不是直接瞎猜。
 */
export function hasDecodingDamage(text: string): boolean {
  let damaged = 0
  // 只扫描前 20000 个字符，够用且不影响大文件性能
  const sample = text.length > 20000 ? text.slice(0, 20000) : text
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) damaged++
  }
  return damaged > 5
}
