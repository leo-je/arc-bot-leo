/**
 * 飞书卡片流式输出的门面。
 *
 * 用法（src/feishu.js 里就这么用的）：
 *
 *   const stream = new CardStream({ client, chatId })
 *   await stream.start()            // 失败会抛，调用方降级成纯文本
 *   stream.append(delta)            // 同步、非阻塞
 *   await stream.finish()           // 或 stream.fail(err)
 *
 * 设计说明见同目录 README.md。
 */
export { CardStream } from './stream.js'
export {
  STREAM_ELEMENT_ID,
  MAX_CARD_CHARS,
  DEFAULT_INITIAL_TEXT,
  textPrefix,
  summaryOf,
  streamingCard,
  markdownCard,
  fitForCard,
  splitForCards,
} from './card.js'
