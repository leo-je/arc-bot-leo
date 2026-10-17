import 'dotenv/config'
import { SessionManager } from './session.js'
import { homedir } from 'os'
import path from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { CONFIG_DIR } from '../lib/config.js'

export const sessionManager = new SessionManager()

/**
 * .env 里的路径不会经过 shell，`~` 不会被展开。
 * 不处理的话 WORK_DIR=~/git 会原样传给 spawn 的 cwd，
 * 结果是「目录不存在」→ spawn 报 ENOENT，但错误信息只说命令名。
 */
export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

// 全局工作目录（所有 Bot 共享，切换时调用 setCurrentWorkDir）
export let currentWorkDir = expandHome(process.env.WORK_DIR) || process.cwd()
export function setCurrentWorkDir(dir) {
  currentWorkDir = expandHome(dir)
}

// ── 运行时状态持久化 ─────────────────────────────────────────────────
// 这些 Map 原来只活在内存里：/ai 切到 gemini，重启就退回 .env 的
// DEFAULT_AI_BACKEND，用户会认为「切了但没记住」。这里落一份 JSON，
// 进程重启后自动恢复。
const STATE_FILE = path.join(CONFIG_DIR, 'state.json')

let hydrating = true

function saveState() {
  if (hydrating) return
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    // 存成数组而不是对象：Telegram 的 chatId 是数字，转对象再读回来
    // 会变成字符串，get(数字) 就永远 miss。
    const payload = {
      backends: [...chatBackendMap],
      models: [...chatModelMap],
      steps: [...stepModeMap],
    }
    writeFileSync(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.warn(`警告：写入 ${STATE_FILE} 失败，/ai 等选择重启后不会保留：${err.message}`)
  }
}

/**
 * 写入即落盘的 Map。做成子类而不是给每个渠道加 save() 调用，
 * 是为了让 index.js / feishu.js / dingtalk.js / whatsapp.js 里
 * 已有的 set/delete 一行都不用改。
 */
class PersistentMap extends Map {
  set(key, value) {
    super.set(key, value)
    saveState()
    return this
  }

  delete(key) {
    const existed = super.delete(key)
    if (existed) saveState()
    return existed
  }

  clear() {
    super.clear()
    saveState()
  }
}

// Per-chatId 状态（Telegram chatId 是数字，飞书 chatId 是 oc_ 字符串，天然不冲突）
export const chatBackendMap = new PersistentMap() // chatId -> 'claude'|'gemini'|'qwen'|'codex'
export const chatModelMap = new PersistentMap()   // chatId -> modelName（每个 chat 独立的模型选择）
export const stepModeMap = new PersistentMap()    // chatId -> 'card'|'text'|'off'（飞书过程展示）

// 会话 id 是后端私有的，跨重启恢复没有意义（还可能撞上已失效的会话），
// 所以这两个保持纯内存。
export const claudeSessionMap = new Map()  // chatId -> sessionId（多轮对话恢复）
export const pendingCustomDir = new Map()  // chatId -> messageId（仅 Telegram 用）

// 从磁盘恢复。hydrating 期间 set() 不触发落盘，否则读一次写一次。
;(() => {
  let data
  try {
    data = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    hydrating = false
    return
  }

  const restore = (map, pairs) => {
    if (!Array.isArray(pairs)) return
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      const [key, value] = pair
      if (typeof key !== 'string' && typeof key !== 'number') continue
      if (typeof value !== 'string' || !value) continue
      map.set(key, value)
    }
  }

  restore(chatBackendMap, data.backends)
  restore(chatModelMap, data.models)
  restore(stepModeMap, data.steps)
  hydrating = false
})()

// 全局配置
export const projects = (() => {
  try {
    const list = JSON.parse(process.env.PROJECTS || '[]')
    // 项目路径同样可能写成 ~/xxx
    return list.map((p) => ({ ...p, path: expandHome(p.path) }))
  } catch {
    console.warn('警告：PROJECTS 环境变量格式错误，请检查 .env 文件中的 JSON 格式')
    return []
  }
})()

export const defaultBackend = process.env.DEFAULT_AI_BACKEND || 'claude'

// Telegram 白名单（数字 userId）
export const allowedUserIds = (process.env.ALLOWED_USER_IDS || '').split(',').map(id => parseInt(id.trim()))
