import 'dotenv/config'
import { SessionManager } from './session.js'
import { homedir } from 'os'
import path from 'path'

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

// Per-chatId 状态（Telegram chatId 是数字，飞书 chatId 是 oc_ 字符串，天然不冲突）
export const chatBackendMap = new Map()    // chatId -> 'claude'|'gemini'|'qwen'|'codex'
export const chatModelMap = new Map()      // chatId -> modelName（每个 chat 独立的模型选择）
export const claudeSessionMap = new Map()  // chatId -> sessionId（多轮对话恢复）
export const pendingCustomDir = new Map()  // chatId -> messageId（仅 Telegram 用）

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
