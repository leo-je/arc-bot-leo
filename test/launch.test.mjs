import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { resolveLaunch, binExists, findBin } from '../src/runners/which.js'
import { expandHome } from '../src/state.js'

const dir = mkdtempSync(path.join(tmpdir(), 'arc-launch-'))

function makeScript(name, shebang) {
  const file = path.join(dir, name)
  writeFileSync(file, `${shebang}\nconsole.log('ok')\n`)
  chmodSync(file, 0o755)
  return file
}

test('expandHome 展开 ~ 与 ~/x，其它原样返回', () => {
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('~/git'), path.join(homedir(), 'git'))
  assert.equal(expandHome('/abs/path'), '/abs/path')
  assert.equal(expandHome('rel/path'), 'rel/path')
  assert.equal(expandHome(''), '')
  assert.equal(expandHome(undefined), undefined)
})

test('#!/usr/bin/env node 被换成当前 node 解释器', () => {
  const file = makeScript('env-node.js', '#!/usr/bin/env node')
  const [cmd, ...pre] = resolveLaunch(file)
  assert.equal(cmd, process.execPath)
  assert.deepEqual(pre, [realpathSync(file)])
})

test('#!/bin/sh 保留解释器与脚本路径', () => {
  const file = makeScript('shell.sh', '#!/bin/sh')
  const [cmd, ...pre] = resolveLaunch(file)
  assert.equal(cmd, '/bin/sh')
  assert.deepEqual(pre, [realpathSync(file)])
})

test('原生可执行文件原样执行，不加解释器', () => {
  // 当前 node 自身就是原生二进制
  const native = realpathSync(process.execPath)
  assert.deepEqual(resolveLaunch(native), [native])
})

test('裸命令名先按 PATH 找到实体，再解析 shebang', () => {
  // 模拟 Termux：PATH 里放一个 #!/usr/bin/env node 的脚本，只给裸名字
  const binDir = path.join(dir, 'fakebin')
  mkdirSync(binDir, { recursive: true })
  const file = path.join(binDir, 'fake-gemini')
  writeFileSync(file, '#!/usr/bin/env node\nconsole.log(1)\n')
  chmodSync(file, 0o755)

  const oldPath = process.env.PATH
  process.env.PATH = `${binDir}:${oldPath}`
  try {
    // 换个名字避免缓存命中
    const [cmd, ...pre] = resolveLaunch('fake-gemini')
    assert.equal(cmd, process.execPath)
    assert.equal(pre[0], realpathSync(file))
  } finally {
    process.env.PATH = oldPath
  }
})

test('不存在的路径原样返回，交给 spawn 报错', () => {
  assert.deepEqual(resolveLaunch('/nonexistent/xyz'), ['/nonexistent/xyz'])
})

test('解释器找不到时退回原命令，不抛异常', () => {
  const file = makeScript('weird.js', '#!/definitely/not/here/interp')
  const argv = resolveLaunch(file)
  assert.ok(Array.isArray(argv) && argv.length >= 1)
})

test('binExists / findBin 不依赖外部的 which 命令', () => {
  const node = realpathSync(process.execPath)
  assert.equal(binExists(node), true)
  assert.equal(binExists('/nonexistent/xyz'), false)
  // findBin 扫的是 PATH，未必就是当前这个解释器（nvm 多版本并存时很常见），
  // 所以只断言「找到了一个可执行的 node」，不断言等于 process.execPath
  const found = findBin('node')
  assert.ok(found, 'PATH 里应该能找到 node')
  assert.equal(path.basename(found), 'node')
  assert.equal(binExists(found), true)
})

after(() => rmSync(dir, { recursive: true, force: true }))
