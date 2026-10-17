/**
 * 飞书卡片 JSON 2.0 的构造工具。
 *
 * 纯函数、不碰网络，方便单测和复用。
 * 协议依据：open.feishu.cn/document/feishu-cards/card-json-v2-structure
 */

/** 流式卡片里承载正文的组件 id。更新接口靠它定位组件，改名要同步改 stream.js。 */
export const STREAM_ELEMENT_ID = 'stream_md'

/** 折叠面板里承载「执行过程」文字的组件 id。 */
export const TOOLS_ELEMENT_ID = 'stream_tools'

/**
 * 折叠面板本身的组件 id。
 *
 * 要单独给面板一个 id：实测 cardElement.patch 改 `expanded` 时必须打在
 * 面板自己身上，打在它的子 markdown 上会报 300313 unknown property。
 */
export const TOOLS_PANEL_ID = 'stream_tools_panel'

/** 执行过程面板的默认标题。 */
export const DEFAULT_TOOLS_TITLE = '🛠️ 执行过程'

/**
 * 卡片消息体上限 30 KB；中文按 UTF-8 一字 3 字节算，再加上 JSON 转义膨胀，
 * 28000 字符是比较安全的余量。
 */
export const MAX_CARD_CHARS = 28000

/** 卡片刚发出、还没有任何输出时显示的话。 */
export const DEFAULT_INITIAL_TEXT = '已收到，正在处理…'

const TRUNCATE_NOTICE = '\n\n…（内容较长，完整结果见下方分段消息）'

/**
 * 按字符截断，且不把 UTF-16 代理对劈开——否则 emoji 会变成乱码方块。
 */
export function textPrefix(text, maxChars) {
  const end = Math.min(text.length, Math.max(0, maxChars))
  if (end >= text.length) return text
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  return text.slice(0, splitsPair ? end - 1 : end)
}

/** 卡片折叠态显示的摘要，飞书上最多 50 字。 */
export function summaryOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= 50) return flat
  return `${textPrefix(flat, 49)}…`
}

/**
 * 执行过程面板：一个折叠块，展开时看到工具调用流水。
 *
 * 为什么用 collapsible_panel 而不是把过程直接拼进正文：
 * ① 面板里的 markdown 是一个独立 element，可以单独走 cardElement.content 流式更新，
 *    不受正文长度影响（实测面板内嵌 markdown 更新正常）；
 * ② 收尾时能用 cardElement.patch 把 expanded 改回 false，让过程自动收起，
 *    正文重新成为卡片的视觉主体。
 */
export function toolsPanel({
  title = DEFAULT_TOOLS_TITLE,
  content = '',
  expanded = true,
  elementId = TOOLS_ELEMENT_ID,
  panelId = TOOLS_PANEL_ID,
} = {}) {
  return {
    tag: 'collapsible_panel',
    element_id: panelId,
    expanded: Boolean(expanded),
    background_color: 'grey-50',
    border: { color: 'grey', corner_radius: '8px' },
    padding: '8px',
    header: {
      title: { tag: 'plain_text', content: title },
      vertical_align: 'center',
      padding: '8px',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: [{ tag: 'markdown', element_id: elementId, content: content || '（暂无）' }],
  }
}

/**
 * 构造流式卡片。
 *
 * streaming_config 交给客户端自己做逐字打印，服务端只要推"当前完整文本"即可，
 * 不需要算增量——这也是我们敢用 300ms 节流的原因。
 *
 * 第二个参数兼容老的 `streamingCard(text, elementId)` 调用形式。
 */
export function streamingCard(initialText = DEFAULT_INITIAL_TEXT, options = {}) {
  const { elementId = STREAM_ELEMENT_ID, tools = null } =
    typeof options === 'string' ? { elementId: options } : options

  const elements = []
  if (tools) elements.push(toolsPanel(tools))
  elements.push({ tag: 'markdown', element_id: elementId, content: initialText })

  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '正在生成…' },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
    },
    body: { elements },
  }
}

/** 静态 markdown 卡片，用于超长内容的分段补发。 */
export function markdownCard(text, elementId = STREAM_ELEMENT_ID) {
  return {
    schema: '2.0',
    body: {
      elements: [{ tag: 'markdown', element_id: elementId, content: text }],
    },
  }
}

/**
 * 算出卡片里能放下的部分。
 *
 * 返回 used 是为了让调用方拿到"卡片已展示到第几个字符"，
 * 好把剩下的内容拿去分段补发。
 */
export function fitForCard(text, limit = MAX_CARD_CHARS) {
  const source = String(text ?? '')
  if (source.length <= limit) return { text: source, overflow: false, used: source.length }
  const head = textPrefix(source, limit - TRUNCATE_NOTICE.length)
  return { text: head + TRUNCATE_NOTICE, overflow: true, used: head.length }
}

/**
 * 把超出卡片容量的内容切成若干段，尽量在换行处断开，
 * 避免把代码块、表格从中间劈成两半导致渲染错乱。
 */
export function splitForCards(text, limit = MAX_CARD_CHARS) {
  const chunks = []
  let rest = String(text ?? '')
  while (rest.length > limit) {
    const head = textPrefix(rest, limit)
    const cut = head.lastIndexOf('\n')
    // 断点太靠前说明这段根本没换行，只能硬切
    const end = cut >= limit * 0.6 ? cut + 1 : head.length
    chunks.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) chunks.push(rest)
  return chunks
}
