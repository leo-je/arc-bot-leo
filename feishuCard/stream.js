import {
  STREAM_ELEMENT_ID,
  DEFAULT_INITIAL_TEXT,
  streamingCard,
  markdownCard,
  summaryOf,
  fitForCard,
  splitForCards,
} from './card.js'

/** 两次卡片更新之间的最小间隔。飞书流式接口本身不限 QPS，纯粹是为了少打点请求。 */
const DEFAULT_THROTTLE_MS = 300

function assertApiSuccess(operation, response) {
  if (response && typeof response.code === 'number' && response.code !== 0) {
    throw new Error(`${operation} 失败: ${response.msg || response.code}`)
  }
  return response
}

/**
 * 一条流式卡片的生命周期。
 *
 * 一次任务对应一个实例：start() 建卡并发出 → append() 喂增量 →
 * finish() / fail() 收尾。更新推的是"当前完整文本"，逐字动画交给客户端。
 */
export class CardStream {
  #client
  #chatId
  #throttleMs
  #elementId
  #logger

  #cardId = null
  #messageId = null
  #sequence = 0
  #buffer = ''
  #sent = ''
  #dirty = false
  #closed = false
  #timer = null
  #pumpPromise = null
  #lastFlushAt = 0
  #overflowChunks = []

  constructor({
    client,
    chatId,
    throttleMs = DEFAULT_THROTTLE_MS,
    elementId = STREAM_ELEMENT_ID,
    logger = console,
  }) {
    if (!client) throw new TypeError('CardStream 需要一个飞书 client')
    if (!chatId) throw new TypeError('CardStream 需要 chatId')
    this.#client = client
    this.#chatId = chatId
    this.#throttleMs = throttleMs
    this.#elementId = elementId
    this.#logger = logger
  }

  get cardId() { return this.#cardId }
  get messageId() { return this.#messageId }
  get text() { return this.#buffer }

  /** 建卡 + 发消息。失败直接抛，由调用方决定是否降级成纯文本。 */
  async start() {
    const created = await this.#client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(streamingCard(DEFAULT_INITIAL_TEXT, this.#elementId)) },
    })
    assertApiSuccess('card.create', created)
    const cardId = created?.data?.card_id
    if (!cardId) throw new Error('card.create 没有返回 card_id，无法更新卡片')
    this.#cardId = cardId

    const message = await this.#client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: this.#chatId,
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      },
    })
    assertApiSuccess('message.create', message)
    this.#messageId = message?.data?.message_id ?? null
    this.#lastFlushAt = Date.now()
    return { cardId, messageId: this.#messageId }
  }

  /** 追加一段增量输出。非阻塞，内部自行节流。 */
  append(delta) {
    if (this.#closed || !delta) return
    this.#buffer += String(delta)
    this.#dirty = true
    this.#schedule()
  }

  /** 收尾：推最后一版、关掉流式模式、补发超长部分。 */
  async finish({ summary } = {}) {
    if (this.#closed) return this.#result()
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (this.#pumpPromise) await this.#pumpPromise.catch(() => {})

    const finalText = this.#buffer || '（任务已完成，没有文本输出）'
    const fitted = fitForCard(finalText)
    // 收尾必须落地，不再受节流限制
    if (fitted.text !== this.#sent) {
      this.#dirty = false
      try {
        await this.#update(fitted.text)
      } catch (err) {
        this.#logger.warn?.('[feishuCard] 收尾更新卡片失败:', err.message)
      }
    }
    this.#closed = true

    if (fitted.overflow) {
      this.#overflowChunks = splitForCards(finalText.slice(fitted.used))
    }

    try {
      await this.#applySettings({ summary: summary || summaryOf(finalText) || '任务完成' })
    } catch (err) {
      this.#logger.warn?.('[feishuCard] 关闭流式模式失败:', err.message)
    }

    for (const chunk of this.#overflowChunks) {
      try {
        await this.#sendStaticCard(chunk)
      } catch (err) {
        this.#logger.warn?.('[feishuCard] 补发分段消息失败:', err.message)
      }
    }

    return this.#result()
  }

  /** 出错收尾：把错误写进卡片，再走正常 finish。 */
  async fail(error) {
    const message = error?.message ?? String(error ?? '未知错误')
    this.append(`\n\n---\n**执行中断**：${message}`)
    return this.finish({ summary: '执行中断' })
  }

  #result() {
    return { cardId: this.#cardId, messageId: this.#messageId, overflowChunks: this.#overflowChunks.length }
  }

  #schedule() {
    if (this.#closed || this.#timer || this.#pumpPromise) return
    const wait = Math.max(0, this.#throttleMs - (Date.now() - this.#lastFlushAt))
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#kick()
    }, wait)
    this.#timer.unref?.()
  }

  #kick() {
    if (!this.#pumpPromise) {
      this.#pumpPromise = this.#pump()
        // 泵是后台跑的，没人 await；必须自己兜住 reject，否则会变成 unhandledRejection
        .catch((err) => this.#logger.warn?.('[feishuCard] 卡片更新异常:', err.message))
        .finally(() => {
          this.#pumpPromise = null
          // 泵退出时如果还有没推出去的内容，补一次尾巴，否则会卡住
          if (this.#dirty && !this.#closed) this.#schedule()
        })
    }
    return this.#pumpPromise
  }

  async #pump() {
    while (this.#dirty && !this.#closed) {
      if (Date.now() - this.#lastFlushAt < this.#throttleMs) {
        this.#schedule()
        return
      }
      this.#dirty = false
      const fitted = fitForCard(this.#buffer)
      if (fitted.text === this.#sent) continue
      try {
        await this.#update(fitted.text)
      } catch (err) {
        this.#logger.warn?.('[feishuCard] 更新卡片失败:', err.message)
        return
      }
      this.#lastFlushAt = Date.now()
    }
  }

  async #update(text) {
    const response = await this.#client.cardkit.v1.cardElement.content({
      path: { card_id: this.#cardId, element_id: this.#elementId },
      data: {
        content: text,
        sequence: ++this.#sequence,
        uuid: `content_${this.#cardId}_${this.#sequence}`,
      },
    })
    assertApiSuccess('cardElement.content', response)
    this.#sent = text
  }

  async #applySettings({ summary }) {
    const response = await this.#client.cardkit.v1.card.settings({
      path: { card_id: this.#cardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }),
        sequence: ++this.#sequence,
        uuid: `settings_${this.#cardId}_${this.#sequence}`,
      },
    })
    assertApiSuccess('card.settings', response)
  }

  async #sendStaticCard(text) {
    const created = await this.#client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(markdownCard(text, this.#elementId)) },
    })
    assertApiSuccess('card.create(static)', created)
    const cardId = created?.data?.card_id
    if (!cardId) throw new Error('card.create(static) 没有返回 card_id')
    const message = await this.#client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: this.#chatId,
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      },
    })
    assertApiSuccess('message.create(static)', message)
  }
}
