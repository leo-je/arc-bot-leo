/**
 * 应用头像。
 *
 * 事实澄清（别被别处的说法带偏）：
 *   1. 飞书**没有**「创建后修改应用头像」的 OpenAPI。
 *      `PATCH /open-apis/application/v6/applications/:app_id` 只能改**应用分组**。
 *   2. 唯一可编程的入口是创建时的 `appPreset.avatar`，它要求**公网可访问**的
 *      图片 URL（png/jpg/jpeg/webp/gif，1~6 个，第一个为默认选中）。
 *   3. 所以本模块只做「URL 校验 + 默认值解析」，不做上传——本地文件传不上去。
 *
 * 默认**不启用**：ARC 是本地 CLI，没有图床。仓库里内置了一张 PNG，但它要等
 * 代码推送到远端、且飞书服务器能访问 raw.githubusercontent.com 才有效。
 * 这两条都不满足时硬塞一个 URL，结果就是用户看到一个裂掉的头像。
 */

/** 仓库内置头像的 raw 地址（需推送后才可达）。 */
export const BUILTIN_AVATAR_URL =
  'https://raw.githubusercontent.com/leo-je/arc-bot-leo/main/feishuQr/assets/avatar.png'

/** 内置头像的文件路径（相对本模块）。 */
export const BUILTIN_AVATAR_FILE = new URL('./assets/avatar.png', import.meta.url)

const ALLOWED_EXT = /\.(png|jpe?g|webp|gif)(\?.*)?$/i

/**
 * 把用户输入解析成 `appPreset.avatar` 能接受的值。
 *
 * @param {object} [options]
 * @param {string|false|null} [options.avatar]  'builtin' | https URL | false/null（禁用）
 * @returns {string|string[]|undefined} undefined 表示不传头像
 */
export function resolveAvatarUrl({ avatar } = {}) {
  if (avatar === false || avatar === null || avatar === undefined) return undefined
  if (typeof avatar !== 'string') {
    throw new Error('avatar 必须是字符串（"builtin" 或 https URL），或 false 表示禁用。')
  }

  const value = avatar.trim()
  if (!value || value === 'none' || value === 'off') return undefined
  if (value === 'builtin' || value === 'default') return BUILTIN_AVATAR_URL

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(
      `头像必须是公网可访问的 http(s) URL，收到的是：${value}\n` +
      `本地文件路径无法使用——飞书是由它的服务器去拉取头像的。`
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`头像 URL 协议必须是 http/https，收到：${parsed.protocol}`)
  }
  if (!ALLOWED_EXT.test(parsed.pathname)) {
    // 只警告不拦截：有些图床 URL 不带扩展名但仍是图片。
    return value
  }
  return value
}

/** 给文档 / 提示语用的一句话说明。 */
export function describeAvatarSupport() {
  return [
    '飞书只在**创建应用时**接受头像（appPreset.avatar），创建后没有 API 可改。',
    '头像必须是公网可访问的图片 URL，本地文件不行。',
    `内置头像：${BUILTIN_AVATAR_URL}`,
    '默认不启用；要启用加 --avatar builtin 或 --avatar <https URL>。',
  ].join('\n')
}
