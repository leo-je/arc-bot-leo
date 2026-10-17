/**
 * @larksuiteoapi/node-sdk 的惰性加载与能力检查。
 *
 * 为什么惰性：ARC 的其余渠道（telegram / dingtalk / whatsapp）完全不需要飞书 SDK，
 * 只有真正走到扫码流程时才付出加载代价。
 *
 * 关于最低版本：registerApp（扫码创建应用）自 1.61.0 起提供。
 * 实测 1.59.0 / 1.60.0 的 lib/index.js 里搜不到 `app/registration` 端点。
 */

const MIN_SDK_VERSION = '1.61.0'
const SDK_PACKAGE = '@larksuiteoapi/node-sdk'

let cachedModule = null

/** 加载 SDK 命名空间（带一次缓存）。失败时给出可操作的错误。 */
export async function loadLarkSdk() {
  if (cachedModule) return cachedModule
  try {
    cachedModule = await import(SDK_PACKAGE)
  } catch (err) {
    throw new Error(
      `加载 ${SDK_PACKAGE} 失败：${err.message}\n` +
      '请先在项目根目录执行 npm install。'
    )
  }
  return cachedModule
}

/** 读取实际安装的 SDK 版本，读不到返回 'unknown'（不影响主流程）。 */
export async function readSdkVersion() {
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    return require(`${SDK_PACKAGE}/package.json`).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 取得 registerApp 函数；版本过低时抛出带修复命令的错误。
 * 单独抽出来是因为「版本不对」是这个功能最常见的失败原因，
 * 必须给出明确的升级指令而不是 `registerApp is not a function`。
 */
export async function requireRegisterApp() {
  const lark = await loadLarkSdk()
  if (typeof lark.registerApp !== 'function') {
    const version = await readSdkVersion()
    throw new Error(
      `当前 ${SDK_PACKAGE} 版本为 ${version}，不提供 registerApp（扫码创建应用）。\n` +
      `该能力自 ${MIN_SDK_VERSION} 起可用，请执行：\n` +
      `  npm install ${SDK_PACKAGE}@^${MIN_SDK_VERSION}`
    )
  }
  return lark.registerApp
}

/** 建一个普通飞书客户端（注册 "/" 快捷指令等接口调用需要）。 */
export async function createFeishuClient({ appId, appSecret, domain = 'feishu' }) {
  const lark = await loadLarkSdk()
  return new lark.Client({
    appId,
    appSecret,
    domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
  })
}

export { MIN_SDK_VERSION, SDK_PACKAGE }
