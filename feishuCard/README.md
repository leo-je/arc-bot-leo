# feishuCard — 飞书卡片流式输出

> 本目录是**新增功能目录**，不属于 ARC 原有结构。把它整个删掉、并去掉 `src/feishu.js` 里那处接入点，即可完全回到原状，不影响任何其它渠道。

## 为什么要有它

原来 ARC 用 `msg_type: 'text'` 发消息，飞书**不会**渲染 Markdown——文档明确写了 `text` 类型"仅适用于普通文本和部分轻量格式"。所以模型输出的 `## 标题`、列表、代码块，在飞书里全成了裸字符。

更麻烦的是 `onOutput` 每 500ms 落一次盘就发一条**独立消息**，一段回答被切成几十条，就算消息类型支持 Markdown，结构也早断了。

这个目录把输出收拢到**一张卡片**里：卡片只发一次，之后原地更新内容，Markdown 由卡片渲染。

## 它做了什么

| 步骤 | 调用 | 说明 |
|---|---|---|
| 1 | `cardkit.v1.card.create` | 建卡片实体，`streaming_mode: true`；开了过程面板时body里多一个 `collapsible_panel` |
| 2 | `im.v1.message.create` | 以 `msg_type: 'interactive'` 发出引用该卡片的消息 |
| 3 | `cardkit.v1.cardElement.content` | 反复推送**当前完整文本**，`sequence` 自增；正文（`stream_md`）和过程面板（`stream_tools`）各推各的 |
| 4 | `cardkit.v1.cardElement.patch` | 收尾时把过程面板的 `expanded` 改成 `false`，让它自动收起 |
| 5 | `cardkit.v1.card.settings` | `streaming_mode: false`，收尾 |

第 3 步推的是全量，不是增量。飞书客户端按 `streaming_config` 里的 `print_frequency_ms` / `print_step` 自己做逐字打印，服务端没必要算差量——这也是敢用 300ms 节流的原因。

## 执行过程面板

工具调用（`onToolUse`）不进正文，进卡片顶部一个可折叠的 `collapsible_panel`：

```
┌─────────────────────────┐
│ 🛠️ 执行过程          ⌄  │  ← 运行中展开、结束后自动收起
│ - ✅ 读取文件: a.js      │
│ - ✅ 执行命令: npm test  │
├─────────────────────────┤
│ ## 回答正文（Markdown） │
└─────────────────────────┘
```

三个设计决策，都是被实测逼出来的：

1. **面板里嵌一个独立的 markdown 元素**（`stream_tools`），而不是把过程拼进正文。因为 `cardElement.content` 是按 `element_id` 定位组件的，只有独立元素才能单独流式更新而不影响正文长度。
2. **面板自己也要有 `element_id`**（`stream_tools_panel`）。实测 `cardElement.patch` 改 `expanded` 必须打在面板本体上；打在它的子 markdown 上会报 `300313 unknown property, property: expanded`。
3. **正文预算要扣掉面板占用**。卡片总量是固定的，正文可用字符数 = `MAX_CARD_CHARS - 面板文本长度`（下限 4000），否则两边一起涨会超出容量。

面板的其他行为：

- 最多留 120 条记录，超出丢最老的（最新的动作一定要能看到）。
- 连续重复的动作压成一条并标 `×N`，否则同一个命令重跑几次就刷屏了。
- 收尾必须**先** patch 收起面板、**再**关流式模式。顺序反了组件接口直接报 `300309 streaming mode is closed`。

## 命令：动态切换展示模式与后端

`src/feishu.js` 里两个命令，都是即时生效、只影响当前会话：

| 命令 | 作用 |
|---|---|
| `/steps` | 查看当前模式 |
| `/steps card` | 默认。过程收进卡片折叠面板，运行中展开、结束后收起 |
| `/steps text` | 旧行为，每条工具调用发一条 `🔧 …` 独立消息 |
| `/steps off` | 完全不展示过程，只看结果 |
| `/ai` | 弹后端菜单 |
| `/ai gemini` | 直接切到 gemini，按 key 或显示名匹配，不区分大小写 |

`/ai <名称>` 切换后会清掉 `claudeSessionMap`——resume id 是后端私有的，不清会被新后端拿去 resume 一个不存在的会话。

模式存在内存里（和 `chatBackendMap` 一致），进程重启就回默认值 `card`。

## 文件

| 文件 | 职责 |
|---|---|
| `card.js` | 卡片 JSON 2.0 构造、摘要、截断、超长分段。纯函数、无网络，可直接单测 |
| `stream.js` | `CardStream` 类，负责创建/节流更新/收尾/降级 |
| `index.js` | 对外导出 |

## 几个必须知道的约束

- **卡片消息体上限 30 KB**（这条是对 `message.create` 发卡片消息而言）。但**内容更新走的是 `cardkit.cardElement.content`，不套这个限制**——实测推 84 KB 中文（28,000 字）照样 `code=0`。即便如此正文仍按 `MAX_CARD_CHARS = 28000` 字符卡住：再长的话单次更新耗时明显、客户端渲染也吃力，不如分段。超了就在卡片里截断并提示，剩下的用静态卡片补发。
- **流式模式 10 分钟自动关闭**。长任务超时会看到卡片停止更新，但内容不受影响。
- **更新要带 `sequence` 且严格递增**，`uuid` 用于幂等去重。乱序或重复号会被飞书拒绝。
- **`element_id` 必须和卡片里定义的一致**，否则 `cardElement.content` 报 `element not found`。
- **卡片交互回调有坑**：处理 `card.action.trigger` 之前必须先关掉 `streaming_mode`，否则更新会被拒。本目录目前不处理回调。

## 权限

需要 `cardkit:card:write`（租户级）。

- 用 `arc-bot feishu-qr` 扫码建出来的应用，该权限已在 `feishuQr/provision.js` 的 `PROVISION_TENANT_SCOPES` 里声明，开箱可用。
- 手工建的老应用需要去开发者后台自己加，然后**发布版本**才生效。缺权限时报 `99991672`。

## 降级策略

`src/feishu.js` 里建卡失败（权限被撤、网络抖动、卡片接口变更）不会让任务挂掉，会 `console.error` 一句然后回落到原来的纯文本发送。宁可难看，不能不可用。

## 没做的部分

- 卡片按钮、表单、回调交互——需要 `card.action.trigger` 事件订阅和 `streaming_mode` 生命周期管理，等真有需求再说。
- 富文本 `post` 兜底。如果哪天卡片彻底不可用，比纯文本好看的中间档是 `post + md` 标签（支持 CommonMark 0.31 + GFM，上限 30 KB）。目前没实现，纯文本兜底够用。
