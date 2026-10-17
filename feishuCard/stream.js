import {
  STREAM_ELEMENT_ID,
  TOOLS_ELEMENT_ID,
  TOOLS_PANEL_ID,
  DEFAULT_TOOLS_TITLE,
  DEFAULT_INITIAL_TEXT,
  MAX_CARD_CHARS,
  streamingCard,
  markdownCard,
  summaryOf,
  fitForCard,
  splitForCards,
} from './card.js'

/** 两次卡片更新之间的最小间隔。飞书流式接口本身不限 QPS，纯粹是为了少打点请求。 */
const DEFAULT_THROTTLE_MS = 300

/** 面板里最多留多少条工具记录。超出时丢最老的，保证最新动作总能看到。 */
const DEFAULT_MAX_TOOL_LINES = 120

/** 工具描述最长保留多少字符，防止某个工具的入参把面板撑爆。 */
const MAX_TOOL_LABEL_CHARS = 160

/** 正文至少给多少字符，避免工具记录太多把正文挤没。 */
const MIN_ANSWER_CHARS = 4000

function assertApiSuccess(operation, response) {
  if (response && typeof response.code === 'number' && response.code !== 0) {
    throw new Error(`${operation} 失败: ${response.msg || response.code}`)
  }
  return response
}

function clipLine(text, maxChars) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const before = flat.charCodeAt(maxChars - 1)
  const after = flat.charCodeAt(maxChars)
  // 别把 emoji 的代理对劈成两半
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  return `${flat.slice(0, splitsPair ? maxChars - 1 : maxChars)}…`
}

/**
 * 一条流式卡片的生命周期。
 *
 * 一次任务对应一个实例：start() 建卡并发出 → append() 喂增量 / appendTool() 记工具动作 →
 * finish() / fail() 收尾。更新推的是"当前完整文本"，逐字动画交给客户端。
 *
 * 卡片结构：顶部是可折叠的执行过程面板，下面是正文 markdown。两者独立更新，
 * 收尾时把面板 patch 成收起态。
 */
export class CardStream {
  #client
  #chatId
  #throttleMs
  #elementId
  #logger

  #toolsEnabled
  #toolsTitle
  #toolsExpanded
  #toolsElementId
  #toolsPanelId
  #maxToolLines
  #toolLines = []
  #toolsSent = ''

  #cardId = null
  #messageId = null
  #sequence = 0
  #buffer = ''
  #sent = ''
  #dirty = false
  #toolsDirty = false
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
    tools = true,
    toolsTitle = DEFAULT_TOOLS_TITLE,
    toolsExpanded = true,
    toolsElementId = TOOLS_ELEMENT_ID,
    toolsPanelId = TOOLS_PANEL_ID,
    maxToolLines = DEFAULT_MAX_TOOL_LINES,
    logger = console,
  }) {
    if (!client) throw new TypeError('CardStream 需要一个飞书 client')
    if (!chatId) throw new TypeError('CardStream 需要 chatId')
    this.#client = client
    this.#chatId = chatId
    this.#throttleMs = throttleMs
    this.#elementId = elementId
    this.#logger = logger
    this.#toolsEnabled = tools !== false
    this.#toolsTitle = toolsTitle
    this.#toolsExpanded = toolsExpanded !== false
    this.#toolsElementId = toolsElementId
    this.#toolsPanelId = toolsPanelId
    this.#maxToolLines = maxToolLines
  }

  get cardId() { return this.#cardId }
  get messageId() { return this.#messageId }
  get text() { return this.#buffer }
  get toolCount() { return this.#toolLines.length }

  /** 建卡 + 发消息。失败直接抛，由调用方决定是否降级成纯文本。 */
  async start() {
    const card = streamingCard(DEFAULT_INITIAL_TEXT, {
      elementId: this.#elementId,
      tools: this.#toolsEnabled
        ? {
            title: this.#toolsTitle,
            content: '',
            expanded: this.#toolsExpanded,
            elementId: this.#toolsElementId,
            panelId: this.#toolsPanelId,
          }
        : null,
    })

    const created = await this.#client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(card) },
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

    // 建卡时已把初始文案写进卡片，记下来避免第一轮重复推同样内容
    this.#sent = DEFAULT_INITIAL_TEXT
    this.#toolsSent = this.#toolsContent()

    if (this.#dirty || this.#toolsDirty) this.#schedule()
    return { cardId, messageId: this.#messageId }
  }

  /** 追加一段增量输出。非阻塞，内部自行节流。 */
  append(delta) {
    if (this.#closed || !delta) return
    this.#buffer += String(delta)
    this.#dirty = true
    this.#schedule()
  }

  /**
   * 记录一次工具调用。工具动作不进正文，只进顶部的执行过程面板。
   *
   * 连续重复的动作（比如同一个命令重跑）压成一条并标记 ×N，否则面板会被刷屏。
   */
  appendTool(label) {
    if (this.#closed || !this.#toolsEnabled) return
    const line = clipLine(label, MAX_TOOL_LABEL_CHARS)
    if (!line) return

    const last = this.#toolLines[this.#toolLines.length - 1]
    const repeated = last && last.text === line ? last : null
    if (repeated) {
      repeated.count += 1
    } else {
      this.#toolLines.push({ text: line, count: 1 })
      if (this.#toolLines.length > this.#maxToolLines) this.#toolLines.shift()
    }
    this.#toolsDirty = true
    this.#schedule()
  }

  /** 收尾：推最后一版、收起过程面板、关掉流式模式、补发超长部分。 */
  async finish({ summary } = {}) {
    if (this.#closed) return this.#result()
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (this.#pumpPromise) await this.#pumpPromise.catch(() => {})

    const finalText = this.#buffer || '（任务已完成，没有文本输出）'
    const toolsContent = this.#toolsContent()
    const fitted = fitForCard(finalText, this.#answerLimit(toolsContent))

    // 收尾必须落地，不再受节流限制
    if (fitted.text !== this.#sent) {
      try {
        await this.#updateElement(this.#elementId, fitted.text)
      } catch (err) {
        this.#logger.warn?.('[feishuCard] 收尾更新正文失败:', err.message)
      }
    }
    if (this.#toolsEnabled && toolsContent !== this.#toolsSent) {
      try {
        await this.#updateElement(this.#toolsElementId, toolsContent)
      } catch (err) {
        this.#logger.warn?.('[feishuCard] 收尾更新过程面板失败:', err.message)
      }
    }

    this.#closed = true

    if (fitted.overflow) {
      this.#overflowChunks = splitForCards(finalText.slice(fitted.used))
    }

    // 顺序不能反：流式模式关掉之后组件接口就不让改了（实测 300309）
    await this.#collapseToolsPanel()

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

  /** 面板里显示的文本。最新的一条永远保留，前面超额的丢掉并注明。 */
  #toolsContent() {
    if (!this.#toolsEnabled || !this.#toolLines.length) return ''
    return this.#toolLines
      .map(({ text, count }) => (count > 1 ? `- ${text} ×${count}` : `- ${text}`))
      .join('\n')
  }

  /** 正文可用字符数：卡片总量固定，工具面板占多少就要从正文里扣。 */
  #answerLimit(toolsContent) {
    if (!toolsContent) return MAX_CARD_CHARS
    return Math.max(MIN_ANSWER_CHARS, MAX_CARD_CHARS - toolsContent.length)
  }

  #schedule() {
    if (this.#closed || !this.#cardId || this.#timer || this.#pumpPromise) return
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
          if ((this.#dirty || this.#toolsDirty) && !this.#closed) this.#schedule()
        })
    }
    return this.#pumpPromise
  }

  async #pump() {
    while ((this.#dirty || this.#toolsDirty) && !this.#closed) {
      if (Date.now() - this.#lastFlushAt < this.#throttleMs) {
        this.#schedule()
        return
      }

      const textDirty = this.#dirty
      const toolsDirty = this.#toolsDirty
      this.#dirty = false
      this.#toolsDirty = false

      const toolsContent = this.#toolsContent()
      try {
        if (textDirty) {
          const fitted = fitForCard(this.#buffer, this.#answerLimit(toolsContent))
          if (fitted.text !== this.#sent) await this.#updateElement(this.#elementId, fitted.text)
        }
        if (toolsDirty && toolsContent && toolsContent !== this.#toolsSent) {
          await this.#updateElement(this.#toolsElementId, toolsContent)
        }
      } catch (err) {
        this.#logger.warn?.('[feishuCard] 更新卡片失败:', err.message)
        return
      }
      this.#lastFlushAt = Date.now()
    }
  }

  async #updateElement(elementId, content) {
    const response = await this.#client.cardkit.v1.cardElement.content({
      path: { card_id: this.#cardId, element_id: elementId },
      data: {
        content,
        sequence: ++this.#sequence,
        uuid: `content_${this.#cardId}_${this.#sequence}`,
      },
    })
    assertApiSuccess('cardElement.content', response)
    if (elementId === this.#elementId) this.#sent = content
    else this.#toolsSent = content
  }

  /** 把过程面板从展开改成收起。失败不影响主流程。 */
  async #collapseToolsPanel() {
    if (!this.#toolsEnabled || !this.#toolsExpanded || !this.#toolLines.length) return
    try {
      const response = await this.#client.cardkit.v1.cardElement.patch({
        path: { card_id: this.#cardId, element_id: this.#toolsPanelId },
        data: {
          partial_element: JSON.stringify({ expanded: false }),
          sequence: ++this.#sequence,
          uuid: `patch_${this.#cardId}_${this.#sequence}`,
        },
      })
      assertApiSuccess('cardElement.patch', response)
    } catch (err) {
      this.#logger.warn?.('[feishuCard] 收起过程面板失败:', err.message)
    }
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
