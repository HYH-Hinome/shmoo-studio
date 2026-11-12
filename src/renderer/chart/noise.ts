/**
 * 2D Simplex 噪声（纯函数，无第三方依赖）。
 *
 * 为什么自己实现：
 *  - 项目只依赖 zustand，不想为一次“轮廓抖动”引入第三方包；
 *  - 视觉层需要**可复现**：同一个数据集每次重绘必须得到同一形状，
 *    否则切换配色/尺寸会让墨迹轮廓跳动。因此用固定 seed 生成置换表。
 *
 * 算法：Gustavson 的 2D simplex（偏斜网格 → 三个角点贡献求和），
 * 输出范围约 [-1, 1]。实现里不做归一化修正，视觉上足够。
 */

/** 二维偏斜系数：把正方形网格压成三角形网格 */
const F2 = 0.5 * (Math.sqrt(3) - 1)
/** 二维反偏斜系数 */
const G2 = (3 - Math.sqrt(3)) / 6

/** 8 个梯度方向（单位向量与轴向向量混合，经典 simplex 做法） */
const GRADIENTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
]

/** mulberry32：小巧的确定性伪随机数生成器，用于打乱置换表 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成 0..255 的置换表（Fisher–Yates，随机源固定 → 结果可复现） */
function buildPermutation(seed: number): Uint8Array {
  const random = mulberry32(seed)
  const perm = new Uint8Array(512)
  const base = new Uint8Array(256)
  for (let i = 0; i < 256; i++) base[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = base[i]
    base[i] = base[j]
    base[j] = tmp
  }
  // 展开成 512 长度，省去取模运算
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255]
  return perm
}

/** 噪声采样函数签名 */
export type Noise2D = (x: number, y: number) => number

/**
 * 创建一个带 seed 的 2D simplex 噪声函数。
 * 相同 seed 必然得到相同结果，供轮廓缓存与单元测试使用。
 */
export function createNoise2D(seed = 1): Noise2D {
  const perm = buildPermutation(seed)

  /** 单个角点的贡献：梯度向量 · 距离向量，再乘衰减核 */
  const corner = (gi: number, x: number, y: number): number => {
    let t = 0.5 - x * x - y * y
    if (t <= 0) return 0
    const g = GRADIENTS[gi & 7]
    t *= t
    return t * t * (g[0] * x + g[1] * y)
  }

  return (x: number, y: number): number => {
    // 1. 偏斜到 simplex 网格
    const skew = (x + y) * F2
    const i = Math.floor(x + skew)
    const j = Math.floor(y + skew)

    // 2. 反偏斜得到网格原点
    const unskew = (i + j) * G2
    const x0 = x - (i - unskew)
    const y0 = y - (j - unskew)

    // 3. 判断落在下三角还是上三角
    const i1 = x0 > y0 ? 1 : 0
    const j1 = x0 > y0 ? 0 : 1

    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2

    // 4. 三个角点的置换索引（& 255 保证不越界）
    const ii = i & 255
    const jj = j & 255
    const gi0 = perm[ii + perm[jj]] & 7
    const gi1 = perm[ii + i1 + perm[jj + j1]] & 7
    const gi2 = perm[ii + 1 + perm[jj + 1]] & 7

    // 5. 求和（约放大到 [-1, 1]）
    return 55 * (corner(gi0, x0, y0) + corner(gi1, x1, y1) + corner(gi2, x2, y2))
  }
}
