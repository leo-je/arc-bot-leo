import { realpathSync, existsSync, openSync, readSync, closeSync } from 'fs'
import { execFileSync } from 'child_process'
import { BaseRunner } from './base-runner.js'
import { findBin, binExists } from './which.js'

const NODE_BIN = realpathSync(process.execPath)

/** claude 的常见落点：PATH 里找不到时按顺序兜底。 */
const CLAUDE_CANDIDATES = [
  `${process.env.HOME}/.local/bin/claude`,
  `${process.env.HOME}/.claude/local/claude`,
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

function _findClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const found = findBin('claude')
  if (found) return found
  // pm2 的 PATH 常常比登录 shell 窄：PATH 里找不到，但文件其实在。
  return CLAUDE_CANDIDATES.find((p) => p && existsSync(p)) || 'claude'
}
const CLAUDE_BIN = _findClaudeBin()

/**
 * 判断 claude 该怎么拉起。
 *
 * 历史原因：claude 曾经只是 node 脚本（cli.js），所以早期实现固定用
 * `node <claude.js>` 启动。官方现在提供原生安装包，claude 是 Mach-O / ELF
 * 可执行文件；再用 node 去跑它，会被当成 JS 解析，直接报
 * `SyntaxError: Invalid or unexpected token`，进程退出码 1。
 *
 * 依据文件头判断：shebang / ELF / Mach-O 就自己执行，其余当作 JS 交给 node。
 * 读不到文件时保持旧行为，不在探测阶段抛错。
 */
function _detectLaunchMode() {
  try {
    const real = realpathSync(CLAUDE_BIN)
    const fd = openSync(real, 'r')
    const head = Buffer.alloc(4)
    readSync(fd, head, 0, 4, 0)
    closeSync(fd)

    const shebang = head[0] === 0x23 && head[1] === 0x21 // "#!"
    const elf = head[0] === 0x7f && head[1] === 0x45 // "\x7fELF"
    const machO =
      (head[0] === 0xcf && head[1] === 0xfa) || // MH_MAGIC_64 小端
      (head[0] === 0xfe && head[1] === 0xed) || // MH_MAGIC 小端
      (head[0] === 0xca && head[1] === 0xfe) || // FAT（通用二进制）
      (head[0] === 0xfe && head[1] === 0xfa) // MH_MAGIC_64 大端

    return shebang || elf || machO ? 'direct' : 'node'
  } catch {
    return 'node'
  }
}

/**
 * 拆成「可执行文件」+「前置参数」：
 *   node 模式 → node + [claude.js]
 *   直跑模式 → claude + []
 */
function _launchCommand() {
  return _detectLaunchMode() === 'node' ? [NODE_BIN, CLAUDE_BIN] : [CLAUDE_BIN]
}

const [CLAUDE_CMD, ...CLAUDE_PRE_ARGS] = _launchCommand()

const SYSTEM_PROMPT = '重要：如果需要启动长期运行的服务（如 npm run dev、npm start、python app.py 等），必须用后台方式运行，例如：nohup npm run dev > /tmp/app.log 2>&1 & 然后输出服务已在后台启动，PID 为 xxx。'

export class ClaudeRunner extends BaseRunner {
  static isAvailable() {
    return binExists(CLAUDE_BIN)
  }

  get displayName() { return 'Claude Code' }

  get binPath() { return CLAUDE_CMD }

  async fetchModels() {
    try {
      const out = execFileSync(CLAUDE_CMD, [...CLAUDE_PRE_ARGS, 'models'], { encoding: 'utf8', timeout: 10000 })
      return out.trim().split('\n').map(l => l.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  buildArgs({ prompt, resumeSessionId, model }) {
    const args = [
      ...CLAUDE_PRE_ARGS,
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--append-system-prompt', SYSTEM_PROMPT,
    ]
    if (model) args.push('--model', model)
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    return args
  }

  buildEnv() {
    return {
      ...process.env,
      CLAUDECODE: '',
      HOOK_SERVER_URL: process.env.HOOK_SERVER_URL || 'http://127.0.0.1:7701',
    }
  }
}
