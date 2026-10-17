#!/usr/bin/env node
import { start, stop, restart, logs, status } from '../lib/pm2-manager.js'
import { runWizard } from '../lib/setup-wizard.js'
import { isConfigured, readEnv } from '../lib/config.js'

const USAGE = `Usage: arc-bot-leo [command]

Commands:
  start    Start the bot (runs setup wizard if not configured)
  config   Run setup wizard to reconfigure
  stop     Stop the bot
  restart  Restart the bot
  logs     Show logs
  status   Show process status
  feishu-qr  扫码创建飞书机器人（自动写入配置，见 feishuQr/README.md）

  --help, -h  Show this help message
`

const cmd = process.argv[2] ?? 'start'

if (cmd === '--help' || cmd === '-h') {
  console.log(USAGE)
  process.exit(0)
}

switch (cmd) {
  case 'start':
    if (!isConfigured()) {
      // Wizard handles writing .env and optionally calling start()
      await runWizard()
    } else {
      await start(readEnv())
    }
    break

  case 'config':
    // Wizard handles writing .env and optionally calling start()
    await runWizard()
    break

  case 'stop':
    await stop()
    break

  case 'restart':
    await restart()
    break

  case 'logs':
    logs()
    break

  case 'status':
    status()
    break

  case 'feishu-qr': {
    // 动态 import：不扫码的用户不为 feishuQr/ 付出加载代价，也减少与上游的冲突面
    try {
      const { runFeishuQrSetup } = await import('../feishuQr/index.js')
      await runFeishuQrSetup(process.argv.slice(3))
    } catch (err) {
      console.error(`\n❌ ${err.message}\n`)
      process.exit(1)
    }
    break
  }

  default:
    console.error(`Unknown command: ${cmd}\n`)
    console.log(USAGE)
    process.exit(1)
}
