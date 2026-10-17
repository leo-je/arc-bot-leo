/**
 * 生成 feishuQr/assets/avatar.png（ARC 的飞书应用头像）。
 *
 * 为什么自己画：ARC 是纯 CLI 项目，没有图床、也不想为一个 256×256 的图标
 * 引入 canvas / sharp 这类重量级依赖。用 zlib 手写 PNG 编码器就够，
 * 零依赖、可重复生成、diff 友好。
 *
 * 用法：node feishuQr/assets/make-avatar.mjs
 *
 * 注意：这个文件只是"生成器"。真正生效要等 avatar.png 被推到远端仓库，
 * 且飞书服务器能访问 raw.githubusercontent.com —— 否则用 --avatar <你的URL>。
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const SS = 4 // 超采样倍数（抗锯齿）
const W = SIZE * SS

// ── 品牌色 ────────────────────────────────────────────────
const BG_TOP = [11, 16, 32]
const BG_BOTTOM = [26, 35, 66]
const RING = [34, 211, 238] // cyan-400
const DOT = [125, 211, 252] // sky-300

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

/** 单个超采样点的颜色；返回 null 表示透明（本图不透明，恒返回颜色）。 */
function sample(x, y) {
  // 背景竖直渐变
  const t = y / (W - 1)
  let color = mix(BG_TOP, BG_BOTTOM, t)

  const cx = W / 2
  const cy = W / 2
  const dx = x - cx
  const dy = y - cy
  const r = Math.hypot(dx, dy)

  // 圆环：外半径 0.33W，环宽 0.085W；留一个朝右下的缺口（缺口中心 45°）
  const outer = W * 0.335
  const inner = outer - W * 0.085
  let angle = Math.atan2(dy, dx) // -π..π
  const gapCenter = Math.PI / 4
  let delta = Math.abs(((angle - gapCenter + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
  const gapHalf = 0.30 // 弧度
  if (r <= outer && r >= inner && delta > gapHalf) {
    color = RING
  }

  // 缺口末端的小圆点（"指针"），暗示 arc 的端点
  const dotAngle = gapCenter + gapHalf + 0.12
  const dotR = (outer + inner) / 2
  const dotX = cx + Math.cos(dotAngle) * dotR
  const dotY = cy + Math.sin(dotAngle) * dotR
  if (Math.hypot(x - dotX, y - dotY) <= W * 0.048) {
    color = DOT
  }

  return color
}

// ── 渲染 + 下采样 ─────────────────────────────────────────
const pixels = Buffer.alloc(SIZE * SIZE * 3)
for (let py = 0; py < SIZE; py += 1) {
  for (let px = 0; px < SIZE; px += 1) {
    const acc = [0, 0, 0]
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const c = sample(px * SS + sx + 0.5, py * SS + sy + 0.5)
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
      }
    }
    const n = SS * SS
    const o = (py * SIZE + px) * 3
    pixels[o] = Math.round(acc[0] / n)
    pixels[o + 1] = Math.round(acc[1] / n)
    pixels[o + 2] = Math.round(acc[2] / n)
  }
}

// ── 最小 PNG 编码器 ───────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor RGB
ihdr[10] = 0 // deflate
ihdr[11] = 0 // adaptive filtering
ihdr[12] = 0 // no interlace

// 每行前面加一个 filter 字节 0（None）
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1))
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 3 + 1)
  raw[rowStart] = 0
  pixels.copy(raw, rowStart + 1, y * SIZE * 3, (y + 1) * SIZE * 3)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const outPath = fileURLToPath(new URL('./avatar.png', import.meta.url))
writeFileSync(outPath, png)
console.log(`已生成 ${outPath}（${SIZE}×${SIZE}，${png.length} 字节）`)
