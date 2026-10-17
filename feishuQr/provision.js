/**
 * 飞书扫码创建应用（registerApp / 设备码流程）。
 *
 * 协议要点（来自 @larksuiteoapi/node-sdk 1.76.0 源码）：
 *   begin → POST {accounts}/oauth/v1/app/registration
 *           action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id
 *           ← { device_code, verification_uri_complete, expires_in, interval }
 *   poll  → POST 同端点 action=poll&device_code=...
 *           ← { client_id, client_secret, user_info }
 *           或 HTTP 400 + { error: authorization_pending | slow_down | access_denied | expired_token }
 *
 * 本模块只做三件事：把二维码递给用户、消费状态变更、把凭据交出去。
 * App Secret 只出现在返回值里，不写日志、不进错误信息。
 */

import os from 'node:os'
import path from 'node:path'
import { requireRegisterApp } from './lib/sdk.js'
import { renderToTerminal, writePng } from './lib/qr.js'

export const DEFAULT_APP_NAME = 'ARC 编码助手'
export const DEFAULT_APP_DESC = '通过飞书远程驱动 AI 编码助手（ARC）。'

/**
 * 扫码创建时一次性申请的租户权限。
 *
 * ⚠️ addons.scopes 在应用创建那一刻就定死了，事后追加要走人工审批，
 * 所以这里必须一次给全——宁可多申请，也不要让用户事后跑一趟后台。
 */
export const PROVISION_TENANT_SCOPES = Object.freeze([
  // 收发消息
  'im:message:send_as_bot',
  'im:message:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  // 流式卡片（智能体形态）
  'cardkit:card:write',
  // 图片 / 文件
  'im:resource',
  // "/" 快捷指令面板
  'application:app_slash_command:read',
  'application:app_slash_command:write',
])

/** 订阅的事件：只收消息。 */
export const PROVISION_EVENTS = Object.freeze(['im.message.receive_v1'])

/** 卡片回调（智能体形态的按钮交互）。 */
export const PROVISION_CALLBACKS = Object.freeze(['card.action.trigger'])

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * `domain` 在 SDK 里指的是**注册服务的主机名**，不是 'feishu'/'lark' 这种简写。
 * 传 'feishu' 会被拼成 https://feishu/oauth/... 然后 ENOTFOUND —— 实测踩过。
 * 这里做一次简写 → 主机名的映射；不认识的值原样透传（允许自定义主机）。
 */
const REGISTRATION_HOSTS = Object.freeze({
  feishu: 'accounts.feishu.cn',
  lark: 'accounts.larksuite.com',
})

function registrationHost(domain) {
  if (!domain) return undefined
  return REGISTRATION_HOSTS[domain] ?? domain
}


/** 把 SDK 抛出的错误翻译成人话。 */
function describeError(err) {
  const code = err?.code ?? err?.error
  switch (code) {
    case 'abort':
      return '已取消（或超时未扫码）。'
    case 'expired_token':
      return '二维码已过期，请重新执行。'
    case 'access_denied':
      return '你在飞书页面取消了授权。'
    default:
      return err?.message ?? String(err)
  }
}

/**
 * 扫码创建应用。
 *
 * @param {object}   [options]
 * @param {string}   [options.name]      应用名称，支持 {user} 占位符（飞书侧替换）
 * @param {string}   [options.desc]      应用描述
 * @param {string|string[]} [options.avatar] 头像公网 URL（1~6 个），默认不传
 * @param {string}   [options.domain]    'feishu' | 'lark'，默认 'feishu'
 * @param {string}   [options.qrPngPath] 二维码 PNG 落盘路径
 * @param {boolean}  [options.writePngFile] 是否落盘 PNG，默认 true
 * @param {Function} [options.log]       日志函数，默认 console.log
 * @param {number}   [options.timeoutMs] 整体超时，默认 10 分钟
 * @returns {Promise<{appId:string, appSecret:string, openId:string|null, domain:string, qrPngPath:string|null}>}
 */
export async function provisionFeishuBot(options = {}) {
  const {
    name = DEFAULT_APP_NAME,
    desc = DEFAULT_APP_DESC,
    avatar,
    domain = 'feishu',
    qrPngPath = path.join(os.homedir(), '.arc-bot-leo', 'feishu-qr.png'),
    writePngFile = true,
    log = console.log,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const registerApp = await requireRegisterApp()

  const appPreset = { name, desc }
  if (avatar) appPreset.avatar = avatar

  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let domainSwitched = false
  let pngPath = null

  try {
    const result = await registerApp({
      domain: registrationHost(domain),
      source: 'arc-bot-leo',
      createOnly: true,
      appPreset,
      addons: {
        // preset:false = 不用平台默认模板，只用最小基座（仅机器人能力）+ 下面显式声明的增量
        preset: false,
        scopes: { tenant: [...PROVISION_TENANT_SCOPES] },
        events: { items: { tenant: [...PROVISION_EVENTS] } },
        callbacks: { items: [...PROVISION_CALLBACKS] },
      },
      signal: controller.signal,

      onQRCodeReady: async ({ url, expireIn }) => {
        const minutes = Math.max(1, Math.round((expireIn ?? 600) / 60))
        log('')
        log(`请用飞书 App 扫描下面的二维码（${minutes} 分钟内有效）：`)
        log('')

        const qr = await renderToTerminal(url)
        if (qr) {
          const termWidth = process.stdout.columns ?? 0
          if (!process.stdout.isTTY) {
            // 输出被重定向到日志/管道时画二维码没有意义，只会污染日志
          } else if (qr.columns > termWidth) {
            log(`（二维码需 ${qr.columns} 列，当前终端只有 ${termWidth} 列——拉宽终端，或扫下面的图片文件）`)
          } else {
            log(qr.art.trimEnd())
          }
        }

        log(`二维码链接：${url}`)

        if (writePngFile) {
          try {
            pngPath = await writePng(url, qrPngPath)
            log(`二维码图片：${pngPath}`)
          } catch (err) {
            log(`（二维码图片写入失败：${err.message}；直接用上面的链接也行）`)
          }
        }
        log('')
      },

      onStatusChange: ({ status, interval }) => {
        if (status === 'slow_down') {
          const secs = interval ? Math.round(interval / 1000) : null
          log(`飞书要求降低轮询频率${secs ? `（已放慢到 ${secs} 秒）` : ''}，继续等待…`)
          return
        }
        if (status === 'domain_switched') {
          domainSwitched = true
          log('检测到 Lark 国际版账号，已自动切换到 larksuite.com 域名…')
        }
        // status === 'polling' 是常态，不刷屏
      },
    })

    if (!result?.client_id || !result?.client_secret) {
      throw new Error('飞书未返回 client_id / client_secret，创建未完成。')
    }

    return {
      appId: result.client_id,
      appSecret: result.client_secret,
      openId: result.user_info?.open_id ?? null,
      domain: domainSwitched ? 'lark' : domain,
      qrPngPath: pngPath,
    }
  } catch (err) {
    const friendly = timedOut ? '等待扫码超时，已取消。' : describeError(err)
    const wrapped = new Error(friendly)
    wrapped.cause = err
    wrapped.code = err?.code
    throw wrapped
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', onSigint)
  }
}
