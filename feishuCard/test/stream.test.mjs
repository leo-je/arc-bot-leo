import test from 'node:test'
import assert from 'node:assert/strict'

import { CardStream } from '../index.js'
import { streamingCard, MAX_CARD_CHARS } from '../card.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 记录所有调用的假 client，形状对齐 @larksuiteoapi/node-sdk 的 cardkit/im。 */
function makeClient(calls) {
  return {
    cardkit: {
      v1: {
        card: {
          create: async (a) => {
            calls.push(['card.create', a])
            return { code: 0, data: { card_id: 'card_1' } }
          },
          settings: async (a) => {
            calls.push(['settings', a])
            return { code: 0 }
          },
        },
        cardElement: {
          content: async (a) => {
            calls.push(['content', a])
            return { code: 0 }
          },
          patch: async (a) => {
            calls.push(['patch', a])
            return { code: 0 }
          },
        },
      },
    },
    im: {
      v1: {
        message: {
          create: async (a) => {
            calls.push(['msg.create', a])
            return { code: 0, data: { message_id: 'msg_1' } }
          },
        },
      },
    },
  }
}

const contentsOf = (calls, elementId) =>
  calls.filter((c) => c[0] === 'content' && c[1].path.element_id === elementId).map((c) => c[1].data.content)

test('卡片结构：有面板时面板在前、正文在后；无面板时只有正文', () => {
  const withTools = streamingCard('hi', { tools: { title: 'X' } })
  assert.equal(withTools.body.elements.length, 2)
  assert.equal(withTools.body.elements[0].tag, 'collapsible_panel')
  assert.equal(withTools.body.elements[0].element_id, 'stream_tools_panel')
  assert.equal(withTools.body.elements[0].elements[0].element_id, 'stream_tools')
  assert.equal(withTools.body.elements[1].element_id, 'stream_md')

  assert.equal(streamingCard('hi').body.elements.length, 1)

  // 兼容旧签名 streamingCard(text, elementId)
  assert.equal(streamingCard('hi', 'old_id').body.elements[0].element_id, 'old_id')
})

test('有面板：流式更新、连续工具去重、收尾收起一次', async () => {
  const calls = []
  const s = new CardStream({ client: makeClient(calls), chatId: 'c', throttleMs: 5, tools: true })
  await s.start()

  assert.equal(calls.filter((c) => c[0] === 'card.create').length, 1)
  assert.equal(JSON.parse(calls[0][1].data.data).body.elements[0].tag, 'collapsible_panel')

  s.append('第一段')
  s.appendTool('读取文件: a.js')
  s.appendTool('读取文件: a.js') // 连续重复 → ×2
  s.appendTool('执行命令: npm test')
  await sleep(60)

  const toolUpdates = contentsOf(calls, 'stream_tools')
  assert.ok(toolUpdates.length >= 1, '过程面板应该被更新')
  assert.match(toolUpdates.at(-1), /读取文件: a\.js ×2/)
  assert.match(toolUpdates.at(-1), /执行命令: npm test/)

  s.append('，继续')
  await s.finish()

  const patches = calls.filter((c) => c[0] === 'patch')
  assert.equal(patches.length, 1, '收尾应恰好收起一次')
  assert.equal(patches[0][1].path.element_id, 'stream_tools_panel')
  assert.deepEqual(JSON.parse(patches[0][1].data.partial_element), { expanded: false })

  const settings = calls.filter((c) => c[0] === 'settings')
  assert.equal(settings.length, 1)
  assert.equal(JSON.parse(settings[0][1].data.settings).config.streaming_mode, false)

  assert.match(contentsOf(calls, 'stream_md').at(-1), /第一段，继续/)

  // sequence 严格递增、uuid 不重复
  const seqs = calls.filter((c) => c[1]?.data?.sequence).map((c) => c[1].data.sequence)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence 必须递增')
  assert.equal(new Set(seqs).size, seqs.length, 'sequence 不能重复')
  const uuids = calls.filter((c) => c[1]?.data?.uuid).map((c) => c[1].data.uuid)
  assert.equal(new Set(uuids).size, uuids.length, 'uuid 不能重复')
})

test('tools:false 时不建面板、不 patch', async () => {
  const calls = []
  const s = new CardStream({ client: makeClient(calls), chatId: 'c', throttleMs: 5, tools: false })
  await s.start()

  assert.equal(JSON.parse(calls[0][1].data.data).body.elements.length, 1)

  s.appendTool('不该出现')
  s.append('正文')
  await s.finish()

  assert.equal(calls.filter((c) => c[0] === 'patch').length, 0)
  assert.equal(contentsOf(calls, 'stream_tools').length, 0)
})

test('超长输出：正文落在卡片预算内，工具行被裁剪', async () => {
  const calls = []
  const s = new CardStream({ client: makeClient(calls), chatId: 'c', throttleMs: 5, tools: true })
  await s.start()

  for (let i = 0; i < 100; i += 1) s.appendTool(`工具 ${i} 的调用描述${'x'.repeat(40)}`)
  s.append('正文'.repeat(20000))
  await s.finish()

  const body = contentsOf(calls, 'stream_md').at(-1)
  assert.ok(body.length <= MAX_CARD_CHARS, `正文 ${body.length} 超出 ${MAX_CARD_CHARS}`)

  const tools = contentsOf(calls, 'stream_tools').at(-1)
  assert.ok(tools.split('\n').length <= 120, '工具条数应被裁剪')
})

test('建卡失败时可被上层捕获（返回 rejected promise）', async () => {
  const client = makeClient([])
  client.cardkit.v1.card.create = async () => {
    throw new Error('boom')
  }
  const s = new CardStream({ client, chatId: 'c', throttleMs: 5, tools: true })
  await assert.rejects(() => s.start(), /boom/)
})
