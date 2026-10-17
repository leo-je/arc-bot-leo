import pm2 from 'pm2'  // pm2 is CJS — must use default import in ESM
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const MAIN_SCRIPT = path.resolve(__dirname, '../src/main.js')
// Use project-local pm2 binary, not system-wide
const PM2_BIN = path.resolve(__dirname, '../node_modules/.bin/pm2')

function pm2Connect() {
  return new Promise((resolve, reject) =>
    pm2.connect(err => err ? reject(err) : resolve())
  )
}

function pm2Disconnect() {
  return new Promise(resolve => pm2.disconnect(resolve))
}

/** Start arc-bot-leo under PM2 with the given env object */
export async function start(envObj) {
  await pm2Connect()
  try {
    await new Promise((resolve, reject) =>
      pm2.start({
        script: MAIN_SCRIPT,
        name: 'arc-bot-leo',
        env: { ...envObj, ARC_SKIP_PID_LOCK: '1' },
        autorestart: true,
      }, (err) => err ? reject(err) : resolve())
    )
    console.log('arc-bot-leo started successfully (PM2)')
  } finally {
    await pm2Disconnect()
  }
}

/** Stop the arc-bot-leo PM2 process */
export async function stop() {
  await pm2Connect()
  try {
    await new Promise((resolve, reject) =>
      pm2.stop('arc-bot-leo', (err) => err ? reject(err) : resolve())
    )
    console.log('arc-bot-leo stopped')
  } finally {
    await pm2Disconnect()
  }
}

/** Restart the arc-bot-leo PM2 process */
export async function restart() {
  await pm2Connect()
  try {
    await new Promise((resolve, reject) =>
      pm2.restart('arc-bot-leo', (err) => err ? reject(err) : resolve())
    )
    console.log('arc-bot-leo restarted')
  } finally {
    await pm2Disconnect()
  }
}

/** Tail arc-bot-leo logs via PM2 CLI (inherits stdio for interactive output) */
export function logs() {
  spawn(PM2_BIN, ['logs', 'arc-bot-leo'], { stdio: 'inherit' })
}

/** Show arc-bot-leo PM2 process status */
export function status() {
  spawn(PM2_BIN, ['status', 'arc-bot-leo'], { stdio: 'inherit' })
}

/** Returns true if arc-bot-leo PM2 process is running (status === 'online') */
export async function isRunning() {
  await pm2Connect()
  try {
    const list = await new Promise((resolve, reject) =>
      pm2.list((err, list) => err ? reject(err) : resolve(list))
    )
    return list.some(p => p.name === 'arc-bot-leo' && p.pm2_env?.status === 'online')
  } finally {
    await pm2Disconnect()
  }
}
