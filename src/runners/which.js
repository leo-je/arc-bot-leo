import { accessSync, constants } from 'fs'
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
