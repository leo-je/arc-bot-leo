import { accessSync, constants, openSync, readSync, closeSync, realpathSync } from 'fs'
import path from 'path'

/**
 * 在 PATH 里查找可执行文件，返回第一个命中的绝对路径，找不到返回 null。
 *
 * 为什么不用 `which` / `where`：
 *   1. Termux 之类的精简环境不保证装了 `which`（`command -v` 是 shell 内建，
 *      而这里连 shell 都不想起）。
 *   2. pm2 守护进程的 PATH 常常比登录 shell 窄。`which` 与真正 spawn 时用的是
 *      同一个 PATH，一旦探测口径和运行口径不一致，就会出现「菜单里没有，但手
 *      动跑能跑」这种自相矛盾的现象。
 *
 * 所以这里纯 Node 扫描 PATH，查找规则与 spawn 一致：带路径分隔符的按路径处理，
 * 其余逐个目录拼接，Windows 下再套 PATHEXT。
 */
export function findBin(bin) {
  if (!bin || typeof bin !== 'string') return null
  const target = bin.trim()
  if (!target) return null

  // 自带路径分隔符：当作路径，不再查 PATH
  if (target.includes('/') || (process.platform === 'win32' && target.includes('\\'))) {
    return isExecutable(target) ? path.resolve(target) : null
  }

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, target + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

/** 命令是否可用。 */
export function binExists(bin) {
  return findBin(bin) !== null
}

function isExecutable(p) {
  try {
    // Windows 上 X_OK 等价于 F_OK，行为不变
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const LAUNCH_CACHE = new Map()

/**
 * 决定「怎么拉起这个命令」，返回 [command, ...前置参数]。
 *
 * 原生可执行文件直接跑；脚本则换成它的 shebang 解释器来跑。
 *
 * 起因是 Termux：`gemini` 是个 `#!/usr/bin/env node` 的脚本，而 Termux 没有
 * `/usr/bin`，内核找不到解释器，execve 返回 ENOENT —— spawn 只会告诉你
 * `spawn gemini ENOENT`，看起来像命令不存在，实际文件就在那儿。
 * 这里顺手把 `/usr/bin/env X` 这一层剥掉，直接找 X（node 就用当前进程的解释器），
 * 顺带免疫 env 缺失、PATH 被改这类环境问题。
 */
export function resolveLaunch(bin) {
  if (typeof bin !== 'string' || !bin) return [bin]
  const cached = LAUNCH_CACHE.get(bin)
  if (cached) return cached
  const resolved = _resolveLaunch(bin)
  LAUNCH_CACHE.set(bin, resolved)
  return resolved
}

function _resolveLaunch(bin) {
  // bin 可能是裸命令名（GEMINI_BIN 默认就是 'gemini'），先按 PATH 找到实体
  let target = bin
  if (!path.isAbsolute(bin)) {
    const found = findBin(bin)
    if (found) target = found
  }

  let real
  try {
    real = realpathSync(target)
  } catch {
    // 解析不了就原样交给 spawn，让它在更靠后的位置报错
    return [bin]
  }

  const head = readHead(real)
  if (!head || head.length < 2) return [bin]
  if (isNativeExecutable(head)) return [real]
  if (head[0] !== 0x23 || head[1] !== 0x21) return [bin] // 不是 "#!"

  const line = head.toString('utf8', 2).split('\n')[0].trim()
  const parts = line.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return [bin]

  const [interp, ...interpArgs] = parts

  // #!/usr/bin/env node → 解释器其实是 env 的参数
  if (path.basename(interp) === 'env') {
    const target = interpArgs[0]
    if (!target) return [bin]
    const resolvedTarget = target === 'node' ? process.execPath : findBin(target)
    if (!resolvedTarget) return [bin]
    return [resolvedTarget, real, ...interpArgs.slice(1)]
  }

  const resolvedInterp = isExecutable(interp) ? interp : findBin(path.basename(interp))
  if (resolvedInterp) return [resolvedInterp, ...interpArgs, real]

  return [bin]
}

function readHead(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(256)
      const n = readSync(fd, buf, 0, buf.length, 0)
      return buf.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function isNativeExecutable(head) {
  if (!head || head.length < 4) return false
  // ELF
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true
  // PE (MZ)
  if (head[0] === 0x4d && head[1] === 0x5a) return true
  // Mach-O：32/64 位、大小端、以及 fat binary
  const magic = head.readUInt32BE(0)
  return magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcafebabe ||
    magic === 0xcffaedfe || magic === 0xcefaedfe
}
