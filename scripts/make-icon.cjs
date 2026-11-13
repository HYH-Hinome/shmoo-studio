/**
 * 生成占位应用图标（阶段 ⑧ 打包用）。
 *
 * 设计：深色圆角底 + 5×5 格子的 shmoo 图缩略，主色用应用里的青绿 PASS 色，
 * 点缀两格 FAIL 红，保证在任务栏/开始菜单的小尺寸下也能认出。
 *
 * 为什么要脚本生成而不是直接提交二进制：图标属于可再生成的构建资源，
 * 脚本入库后任何人执行 `npm run make-icon` 都能得到同一张图。
 * 输出：resources/icon.png（electron-builder 作为 Windows 图标源，自动转 .ico）
 */
const { createCanvas } = require('@napi-rs/canvas')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SIZE = 512
const canvas = createCanvas(SIZE, SIZE)
const ctx = canvas.getContext('2d')

/** 圆角矩形路径 */
function roundRect(x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

// 背景：与画布底色一致的深蓝黑，外加一点径向渐变避免死板
ctx.fillStyle = '#0a0f16'
ctx.fillRect(0, 0, SIZE, SIZE)

const glow = ctx.createRadialGradient(SIZE * 0.3, SIZE * 0.25, 20, SIZE * 0.5, SIZE * 0.5, SIZE * 0.8)
glow.addColorStop(0, 'rgba(45,175,114,0.16)')
glow.addColorStop(1, 'rgba(45,175,114,0)')
ctx.fillStyle = glow
ctx.fillRect(0, 0, SIZE, SIZE)

// 外框：细的青绿描边，模拟图表边框
roundRect(40, 40, SIZE - 80, SIZE - 80, 56)
ctx.strokeStyle = 'rgba(147,166,186,0.35)'
ctx.lineWidth = 6
ctx.stroke()

// 5×5 格子：从深青到亮绿的明度阶梯，模拟 margin 明度调制
const N = 5
const LEFT = 84
const TOP = 84
const CELL = (SIZE - LEFT * 2) / N
const GAP = 10
const PALETTE = ['#1d5c55', '#2a7a6b', '#359a7d', '#3fbb8c', '#63d6a5']

for (let iy = 0; iy < N; iy++) {
  for (let ix = 0; ix < N; ix++) {
    // 两格失败点：右下角与中上，位置固定保证可复现
    const fail = (ix === 3 && iy === 1) || (ix === 1 && iy === 3)
    ctx.fillStyle = fail ? '#e04037' : PALETTE[(ix + iy) % PALETTE.length]
    roundRect(LEFT + ix * CELL + GAP / 2, TOP + iy * CELL + GAP / 2, CELL - GAP, CELL - GAP, 12)
    ctx.fill()
  }
}

const outDir = join(__dirname, '..', 'resources')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'icon.png')
writeFileSync(outFile, canvas.toBuffer('image/png'))
console.log(`icon written: ${outFile} (${SIZE}x${SIZE})`)
