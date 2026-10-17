/**
 * `arc-bot-leo feishu-qr` —— 扫码创建飞书机器人并写入配置。
 *
 * 目录约定：本目录下所有文件都是**新增**的，唯一的对外接触面是
 * `runFeishuQrSetup()`（被 bin/arc-bot-leo.js 调一行）。
 * 目的：合并上游时冲突面最小。
 *
 * 不做的事：
 *   - 不碰 src/feishu.js（消息收发、命令解析完全复用现有实现）
 *   - 不引入新的 HTTP 服务、不要公网 IP（走 SDK 的设备码流程）
 */

import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { CONFIG_FILE, readEnv, writeEnv } from '../lib/config.js'
import { provisionFeishuBot, DEFAULT_APP_NAME, DEFAULT_APP_DESC } from './provision.js'
import { registerSlashCommands, rebuildSlashCommands } from './slash-commands.js'
import { resolveAvatarUrl, describeAvatarSupport } from './avatar.js'

const USAGE = `Usage: arc-bot-leo feishu-qr [options]

用手机飞书扫码，自动创建一个飞书自建应用（机器人）并写入配置。
不需要去开发者后台手动创建应用，也不需要公网 IP。

Options:
  --name <名称>        应用名称，默认 "${DEFAULT_APP_NAME}"
  --desc <描述>        应用描述
  --avatar <URL>       应用头像（公网图片 URL，或 builtin 用仓库内置图）
  --no-avatar          不设置头像（默认行为）
  --domain <域名>      feishu（默认）或 lark（Lark 国际版）
  --slash              只重同步 "/" 快捷指令（用已有凭据，不扫码、不改配置）
  --rebuild            删掉全部 "/" 快捷指令再按清单顺序重建
  --skip-slash         跳过 "/" 快捷指令注册
  --force              已配置飞书时也强制重新扫码（会覆盖旧凭据）
  -h, --help           显示本帮助

扫码后请在飞书开发者后台完成「发布」审批，权限才会生效。
`

function parseArgs(argv) {
  const opts = {
    name: DEFAULT_APP_NAME,
    desc: DEFAULT_APP_DESC,
    avatar: undefined,
    domain: 'feishu',
    slashOnly: false,
    rebuild: false,
    skipSlash: false,
    force: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} 缺少取值`)
      i += 1
      return v
    }
    switch (arg) {
      case '--name': opts.name = next(); break
      case '--desc': opts.desc = next(); break
      case '--avatar': opts.avatar = next(); break
      case '--no-avatar': opts.avatar = undefined; break
      case '--domain': opts.domain = next(); break
      case '--slash': opts.slashOnly = true; break
      case '--rebuild': opts.rebuild = true; break
      case '--skip-slash': opts.skipSlash = true; break
      case '--force': opts.force = true; break
      case '-h':
      case '--help': opts.help = true; break
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }
  if (!['feishu', 'lark'].includes(opts.domain)) {
    throw new Error(`--domain 只能是 feishu 或 lark，收到：${opts.domain}`)
  }
  return opts
}

async function confirm(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(question)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** 统一打印 "/" 快捷指令的注册结果。 */
function reportSlash(slash) {
  if (slash.ok) {
    const parts = []
    if (slash.created.length) parts.push(`新建 ${slash.created.map((c) => `/${c}`).join('、')}`)
    if (slash.skipped.length) parts.push(`已存在 ${slash.skipped.map((c) => `/${c}`).join('、')}`)
    if (slash.failed?.length) parts.push(`失败 ${slash.failed.map((f) => `/${f.command}`).join('、')}`)
    console.log(`✅ 快捷指令就绪${parts.length ? `（${parts.join('，')}）` : ''}`)
    return
  }
  console.warn(`⚠️  快捷指令未注册：${slash.error}`)
  console.warn('   不影响收发消息；补好权限后重跑 `arc-bot-leo feishu-qr --slash` 即可。')
}

/**
 * 主入口。失败时抛错，由调用方决定退出码。
 * @returns {Promise<{appId:string, skipped:boolean}>}
 */
export async function runFeishuQrSetup(argv = []) {
  const opts = parseArgs(argv)

  if (opts.help) {
    console.log(USAGE)
    return { appId: '', skipped: true }
  }

  // ── 0. `--slash` / `--rebuild`：只动 "/" 面板，不扫码、不改凭据 ────
  if (opts.slashOnly || opts.rebuild) {
    const env = readEnv()
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
      throw new Error('还没有配置飞书应用，先运行 `arc-bot-leo feishu-qr` 扫码创建。')
    }
    console.log(`正在为 ${env.FEISHU_APP_ID} ${opts.rebuild ? '重建' : '同步'} "/" 快捷指令…`)
    const slash = await (opts.rebuild ? rebuildSlashCommands : registerSlashCommands)({
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      domain: opts.domain,
      log: (msg) => console.log(`   ${msg}`),
    })
    reportSlash(slash)
    return { appId: env.FEISHU_APP_ID, skipped: false }
  }

  // ── 1. 已配置保护 ──────────────────────────────────────
  const existing = readEnv()
  if (existing.FEISHU_APP_ID && existing.FEISHU_APP_SECRET && !opts.force) {
    console.log(`检测到已配置的飞书应用：${existing.FEISHU_APP_ID}`)
    const ok = await confirm('重新扫码会覆盖现有凭据，继续？[y/N] ')
    if (!ok) {
      console.log('已取消，现有配置未改动。')
      return { appId: existing.FEISHU_APP_ID, skipped: true }
    }
  }

  // ── 2. 头像（先校验，别等扫完码才报错）─────────────────
  let avatar
  try {
    avatar = resolveAvatarUrl({ avatar: opts.avatar })
  } catch (err) {
    // 只印「为什么不行」，具体错因交给 CLI 统一打 ❌ 前缀——
    // 两边都打一遍会让用户看到重复的两行。
    console.error(describeAvatarSupport())
    throw err
  }

  // ── 3. 扫码创建 ───────────────────────────────────────
  console.log('正在向飞书申请创建应用…')
  const result = await provisionFeishuBot({
    name: opts.name,
    desc: opts.desc,
    avatar,
    domain: opts.domain,
  })

  console.log('')
  console.log(`✅ 应用已创建：${result.appId}`)

  // ── 4. 注册 "/" 快捷指令（失败不致命）─────────────────
  if (!opts.skipSlash) {
    console.log('正在注册 "/" 快捷指令…')
    try {
      const slash = await registerSlashCommands({
        appId: result.appId,
        appSecret: result.appSecret,
        domain: result.domain,
        log: (msg) => console.log(`   ${msg}`),
      })
      reportSlash(slash)
    } catch (err) {
      console.warn(`⚠️  快捷指令注册异常：${err.message}`)
    }
  }

  // ── 5. 写配置（合并，不覆盖其他渠道）───────────────────
  const merged = {
    ...existing,
    FEISHU_APP_ID: result.appId,
    FEISHU_APP_SECRET: result.appSecret,
  }
  // 扫码人自己加进白名单：否则 FEISHU_ALLOWED_USER_IDS 非空时会把自己挡在外面
  if (result.openId) {
    const list = (existing.FEISHU_ALLOWED_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    if (!list.includes(result.openId)) list.push(result.openId)
    merged.FEISHU_ALLOWED_USER_IDS = list.join(',')
  }
  writeEnv(merged)
  console.log(`✅ 已写入 ${CONFIG_FILE}`)

  // ── 6. 收尾提示 ───────────────────────────────────────
  console.log('')
  if (result.domain === 'lark') {
    console.log('⚠️  该应用属于 Lark 国际版（larksuite.com）。')
    console.log('    ARC 目前只在 src/feishu.js 里使用飞书中国版域名，国际版暂不可用。')
    console.log('')
  }
  console.log('下一步：')
  console.log('  1. 打开飞书开发者后台 → 你的应用 → 版本管理与发布 → 创建版本并申请发布')
  console.log('     （扫码创建的应用需完成发布审批，权限才会生效）')
  console.log('  2. 运行：arc-bot-leo start')
  if (result.qrPngPath) {
    console.log('')
    console.log(`二维码图片已保存在：${result.qrPngPath}（可删除）`)
  }

  return { appId: result.appId, skipped: false }
}

export { USAGE }
