/**
 * 二维码渲染：终端输出 + PNG 落盘。
 *
 * 只用项目已有的 qrcode@^1.5.4，不引新依赖。
 * 终端优先（不落文件、不污染磁盘），PNG 作为兜底（终端字体不等宽或
 * 二维码模块过密时，终端渲染会糊成一片，手机扫不出来）。
 */

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import QRCode from 'qrcode'

/**
 * 纠错等级。
 *
 * 终端用 L、PNG 用 M —— 不是随手写的：
 * 扫码创建应用的 URL 带 gzip+base64 的 addons 参数，约 580 字节，
 * 实测 M 级会撑到 89 模块 / 91 列，超出常见 80 列终端；L 级降到 81 模块 / 83 列。
 * 终端二维码是「屏幕上干净的数字图像」，没有污损风险，降级纠错是安全的；
 * 而 PNG 可能被截图、压缩、打印，所以保留 M。
 */
const ECC_TERMINAL = 'L'
const ECC_PNG = 'M'

/** 去掉 ANSI 转义序列，只留可见字符。 */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** 二维码实际占多少列（取渲染结果里最宽的一行）。 */
function measureColumns(art) {
  return art.split('\n').reduce((max, line) => Math.max(max, stripAnsi(line).length), 0)
}

/**
 * 渲染成终端可打印的字符串（ANSI 半块字符，每个字符宽 1 列）。
 *
 * @returns {Promise<{art:string, columns:number}|null>} 渲染失败返回 null——
 *          终端只是辅助，链接才是权威，不值得为它中断流程。
 */
export async function renderToTerminal(text) {
  try {
    const art = await QRCode.toString(text, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: ECC_TERMINAL,
    })
    return { art, columns: measureColumns(art) }
  } catch {
    return null
  }
}

/** 写 PNG 文件；目录不存在会自动创建。 */
export async function writePng(text, filePath, { width = 512 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await QRCode.toFile(filePath, text, {
    errorCorrectionLevel: ECC_PNG,
    margin: 2,
    width,
  })
  return filePath
}

/** 生成 data URL（预留给未来的 Web 向导）。 */
export async function toDataUrl(text, { width = 320 } = {}) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: ECC_PNG,
    margin: 1,
    width,
    type: 'image/png',
  })
}
