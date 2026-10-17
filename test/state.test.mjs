import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// state.js 在 import 时就会读 CONFIG_DIR（= $HOME/.arc-bot-leo），
// 所以必须在 import 之前把 HOME 指到临时目录，否则会踩到用户真实的 state.json。
const fakeHome = mkdtempSync(path.join(tmpdir(), 'arc-state-'))
const realHome = process.env.HOME
process.env.HOME = fakeHome

const STATE_FILE = path.join(fakeHome, '.arc-bot-leo', 'state.json')

const { chatBackendMap, chatModelMap, stepModeMap } = await import('../src/state.js')
const { CONFIG_DIR } = await import('../lib/config.js')

// ← 保险丝：万一 HOME 覆盖没生效，这个测试必须立刻失败，绝不能去写真实目录
assert.ok(
  CONFIG_DIR.startsWith(fakeHome),
  `CONFIG_DIR 不在临时目录里（${CONFIG_DIR}），拒绝继续`
)

test('set 之后立刻落盘，格式是数组而不是对象', () => {
  chatBackendMap.set('oc_test', 'gemini')
  assert.ok(existsSync(STATE_FILE), 'state.json 应该被创建')
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  assert.deepEqual(saved.backends, [['oc_test', 'gemini']])
  assert.ok(Array.isArray(saved.backends))
})

test('数字 chatId 存进去读出来还是数字', () => {
  chatBackendMap.set(12345, 'qwen')
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  const pair = saved.backends.find(([k]) => k === 12345)
  assert.ok(pair, '数字 key 应该原样存成数字')
  assert.equal(typeof pair[0], 'number')
})

test('model 与 steps 也一起落盘', () => {
  chatModelMap.set('oc_test', 'deepseek-v4.1-flash')
  stepModeMap.set('oc_test', 'text')
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  assert.deepEqual(saved.models, [['oc_test', 'deepseek-v4.1-flash']])
  assert.deepEqual(saved.steps, [['oc_test', 'text']])
})

test('delete 之后磁盘上的记录同步消失', () => {
  chatModelMap.delete('oc_test')
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  assert.deepEqual(saved.models, [])
})

test('文件损坏时不抛异常，退回空状态', () => {
  writeFileSync(STATE_FILE, '{ 这不是 JSON', 'utf8')
  // 重新 import 一个干净副本做不到（模块缓存），这里只验证不会把坏文件写崩
  assert.doesNotThrow(() => chatBackendMap.set('oc_another', 'claude'))
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  assert.ok(saved.backends.some(([k]) => k === 'oc_another'))
})

after(() => {
  process.env.HOME = realHome
  rmSync(fakeHome, { recursive: true, force: true })
})
