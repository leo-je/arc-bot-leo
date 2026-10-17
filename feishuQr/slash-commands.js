/**
 * 飞书原生 "/" 快捷指令面板注册。
 *
 * 机制（官方：/document/mcp_open_tools/agent-best-practices/agent-supports-slash-commands）：
 *   - 面板由飞书客户端渲染，命令清单**存在飞书服务端、按 app 维度保存**，
 *     不是客户端推上去的，所以必须调 OpenAPI 注册。
 *   - 用户点面板里的命令后，飞书把它当**普通文本消息**发回机器人
 *     （走 im.message.receive_v1），所以 ARC 侧的命令解析代码一行都不用改。
 *   - 注册的名字**不带前导斜杠**（写 `clear`，不是 `/clear`）。
 *
 * 权限：application:app_slash_command:read / :write
 */

import { createFeishuClient } from './lib/sdk.js'

const SLASH_ENDPOINT = '/open-apis/application/v7/app_slash_commands'

/** 缺权限时飞书返回的错误码。 */
const MISSING_PERMISSION_CODES = new Set(['99991640', '99991672'])

/**
 * 面板按**创建时间倒序**展示，同一秒内创建的会被平台按内部规则排序。
 * 要控制顺序就必须一条一条建、每条间隔 1.1 秒。目前只有一条，保留该常量备用。
 */
export const SLASH_PANEL_CREATE_INTERVAL_MS = 1_100

/**
 * 要注册的命令清单。
 *
 * 目前只放 /clear —— 与 src/feishu.js 里已实现的命令一一对应。
 * 后续要加 /status、/stop 等，在这里加一行即可，无需改 ARC 其他任何文件。
 */
export const SLASH_COMMANDS = Object.freeze([
  {
    command: 'clear',
    icon: 'clear_outlined',
    zh: '清空对话历史',
    en: 'Clear conversation history',
  },
])

/** 从 SDK 的响应里取业务体（client.request 返回 axios response，取 .data）。 */
function bodyOf(res) {
  return res && typeof res === 'object' && res.data !== undefined ? res.data : res
}

/** 把 SDK / axios 的错误压成 { code, msg }。 */
function normalizeError(err) {
  const payload = err?.response?.data ?? bodyOf(err) ?? {}
  return {
    code: String(payload.code ?? err?.code ?? ''),
    msg: payload.msg ?? err?.message ?? String(err),
  }
}

function slashPayload(entry) {
  return {
    command: entry.command,
    description: {
      default_value: entry.zh,
      i18n: { zh_cn: entry.zh, en_us: entry.en },
      icon: { icon_key: entry.icon },
    },
  }
}

/** 列出已注册的命令 → Map<command, command_id>。 */
async function listRegistered(client) {
  const registered = new Map()
  let pageToken = ''
  for (let guard = 0; guard < 20; guard += 1) {
    const params = { page_size: 100 }
    if (pageToken) params.page_token = pageToken
    const res = await client.request({
      method: 'GET',
      url: SLASH_ENDPOINT,
      params,
    })
    const body = bodyOf(res)
    if (body?.code !== undefined && body.code !== 0) {
      throw Object.assign(new Error(body.msg ?? `code ${body.code}`), { code: String(body.code) })
    }
    for (const item of body?.data?.items ?? []) {
      if (item?.command) registered.set(item.command, item.command_id ?? null)
    }
    pageToken = body?.data?.page_token ?? ''
    if (!body?.data?.has_more || !pageToken) break
  }
  return registered
}

/**
 * 幂等注册：已存在的跳过，缺的补建。
 *
 * @returns {Promise<{ok:boolean, created:string[], skipped:string[], failed:Array, missingPermission:boolean, error?:string}>}
 */
export async function registerSlashCommands({ appId, appSecret, domain = 'feishu', log = () => {} }) {
  const client = await createFeishuClient({ appId, appSecret, domain })
  const summary = { ok: true, created: [], skipped: [], failed: [], missingPermission: false }

  let registered
  try {
    registered = await listRegistered(client)
  } catch (err) {
    const { code, msg } = normalizeError(err)
    if (MISSING_PERMISSION_CODES.has(code)) {
      return {
        ...summary,
        ok: false,
        missingPermission: true,
        error: '应用缺少 application:app_slash_command:read/write 权限，"/" 面板未注册。',
      }
    }
    return { ...summary, ok: false, error: `读取快捷指令列表失败：${msg}` }
  }

  for (let i = 0; i < SLASH_COMMANDS.length; i += 1) {
    const entry = SLASH_COMMANDS[i]
    if (registered.has(entry.command)) {
      summary.skipped.push(entry.command)
      continue
    }
    try {
      const res = await client.request({
        method: 'POST',
        url: SLASH_ENDPOINT,
        data: slashPayload(entry),
      })
      const body = bodyOf(res)
      if (body?.code !== undefined && body.code !== 0) {
        throw Object.assign(new Error(body.msg ?? `code ${body.code}`), { code: String(body.code) })
      }
      summary.created.push(entry.command)
      log(`已注册快捷指令：/${entry.command}`)
    } catch (err) {
      const { code, msg } = normalizeError(err)
      if (MISSING_PERMISSION_CODES.has(code)) {
        summary.ok = false
        summary.missingPermission = true
        summary.error = '应用缺少 application:app_slash_command:write 权限。'
        break
      }
      // 并发下可能已被别处创建，视为成功
      if (/already exists|已存在/i.test(msg)) {
        summary.skipped.push(entry.command)
        continue
      }
      summary.ok = false
      summary.failed.push({ command: entry.command, error: msg })
    }
    // 控制面板顺序（见 SLASH_PANEL_CREATE_INTERVAL_MS 注释）
    if (i < SLASH_COMMANDS.length - 1) {
      await new Promise((r) => setTimeout(r, SLASH_PANEL_CREATE_INTERVAL_MS))
    }
  }

  return summary
}

export { SLASH_ENDPOINT, MISSING_PERMISSION_CODES }
