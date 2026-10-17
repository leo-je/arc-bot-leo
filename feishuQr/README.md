# feishuQr —— 飞书扫码接入

> **这个目录是一个隔离层。** 除了 `bin/arc-bot.js` 和 `lib/setup-wizard.js` 各一处几行的
> 挂载点，飞书扫码相关的全部代码都在这里。目的很直接：**降低合并上游时的冲突面**。
> 如果你要改扫码相关的东西，只需要看这个目录。

---

## 1. 它解决什么问题

原来接飞书要人工去[开发者后台](https://open.feishu.cn/app)建应用、抄 App ID / Secret、
申请权限、配事件订阅——一堆步骤，一步错就收不到消息。

现在：

```bash
npx arc-bot feishu-qr
```

手机飞书扫一下码，应用就建好了，凭据自动写进 `~/.arc-bot/.env`。

**不需要公网 IP**，因为走的是设备码（device code）流程，不是回调。

---

## 2. 快速开始

```bash
# 前提：装依赖（会把 @larksuiteoapi/node-sdk 升到 >=1.61.0）
npm install

# 扫码创建
npx arc-bot feishu-qr

# 或者带参数
npx arc-bot feishu-qr --name "我的编码助手" --avatar builtin
```

也可以在交互式向导里选：

```bash
npx arc-bot config
# → 飞书接入方式: 扫码创建 / 手动填写
```

扫完码之后**还差一步**：打开开发者后台 → 你的应用 → 版本管理与发布 → 创建版本并申请发布。
**扫码创建的应用必须完成发布审批，权限才会生效**——这是飞书侧的产品规则，绕不过去。

---

## 3. 三个能力

### 3.1 扫码创建应用

| 项 | 说明 |
|---|---|
| 端点 | `POST https://accounts.feishu.cn/oauth/v1/app/registration`（**未在开放平台文档站公开**） |
| 入口 | `@larksuiteoapi/node-sdk` 的 `registerApp()`，自 **1.61.0** 起提供 |
| 流程 | `action=begin` 拿 `device_code` + `verification_uri_complete` → 用户扫码 → `action=poll` 拿 `client_id` / `client_secret` |
| 错误 | `authorization_pending`（继续等）/ `slow_down`（退避）/ `access_denied` / `expired_token` |
| 有效期 | 默认 600 秒 |

实现见 [`provision.js`](./provision.js)。关键细节：

- `domain` 传的是**主机名**（`accounts.feishu.cn`），不是 `'feishu'` 这种简写。
  传简写会被拼成 `https://feishu/...` 然后 `ENOTFOUND`——这个坑已经踩过并修掉了。
- `addons` 会被 SDK 编码成 `base64url(gzip(JSON))` 塞进 URL，所以链接约 580 字节，
  二维码会比较密（81 模块）。终端用 L 级纠错压到 83 列，PNG 用 M 级。
- **权限在创建那一刻就定死了**，事后追加要走人工审批。所以
  [`PROVISION_TENANT_SCOPES`](./provision.js) 一次性把现在和近期要用的权限都给全了。

### 3.2 应用头像

```bash
npx arc-bot feishu-qr --avatar builtin              # 用仓库内置图
npx arc-bot feishu-qr --avatar https://x.com/a.png  # 用自己的公网图
```

**必须知道的三件事**（很多文章写错）：

1. 飞书**没有**「创建后修改应用头像」的 OpenAPI。
   `PATCH /open-apis/application/v6/applications/:app_id` 只能改**应用分组**，不含 avatar。
2. 唯一可编程入口是创建时的 `appPreset.avatar`，它要求**公网可访问**的图片 URL。
   本地文件传不上去——是飞书的服务器来拉图。
3. 所以**默认不启用**。仓库里内置了 [`assets/avatar.png`](./assets/avatar.png)，
   但它要等代码推到远端、且飞书服务器能访问 `raw.githubusercontent.com` 才有效。
   两条不满足时硬塞 URL，用户看到的就是裂图。

内置图标由 [`assets/make-avatar.mjs`](./assets/make-avatar.mjs) 生成（手写 PNG 编码器，
零依赖）。改了设计重跑一次即可：

```bash
node feishuQr/assets/make-avatar.mjs
```

### 3.3 "/" 快捷指令

```bash
npx arc-bot feishu-qr            # 默认注册
npx arc-bot feishu-qr --skip-slash   # 跳过
```

- 面板由**飞书客户端**渲染，命令清单存在**飞书服务端**，所以要调 OpenAPI 注册：
  `POST /open-apis/application/v7/app_slash_commands`
- 权限：`application:app_slash_command:read` / `:write`
- 注册的**命令名不带前导斜杠**（写 `clear`，不是 `/clear`）
- 用户点面板里的命令后，飞书把它当**普通文本消息**发回来，走 `im.message.receive_v1`。
  所以 `src/feishu.js` 里的命令解析**一行都不用改**——这是这套方案最省事的地方。
- 幂等：已存在的跳过，只补缺的。缺权限时**不中断**，只提示，因为收发消息不受影响。

当前只注册了 `/clear`。要加 `/status`、`/stop` 等，改
[`slash-commands.js`](./slash-commands.js) 的 `SLASH_COMMANDS` 数组加一行即可。

> 面板按**创建时间倒序**展示，同秒创建顺序不确定。要控顺序就一条条建、每条间隔 1.1 秒
> （常量 `SLASH_PANEL_CREATE_INTERVAL_MS` 已留好）。

---

## 4. 目录结构

```
feishuQr/
├── README.md              ← 本文件（目录标记）
├── index.js               ← CLI 入口：runFeishuQrSetup()，唯一对外接口
├── provision.js           ← 扫码创建应用（registerApp 封装 + 状态消费）
├── slash-commands.js      ← "/" 快捷指令幂等注册
├── avatar.js              ← 头像 URL 校验与默认值解析
├── lib/
│   ├── sdk.js             ← SDK 惰性加载 + 版本检查（错误信息里直接给升级命令）
│   └── qr.js              ← 二维码渲染：终端 / PNG / dataURL
└── assets/
    ├── avatar.png         ← 应用图标（256×256）
    └── make-avatar.mjs    ← 上面那张图的生成器（零依赖 PNG 编码）
```

---

## 5. 对现有文件的改动（就这 3 处）

| 文件 | 改动 | 冲突风险 |
|---|---|---|
| `package.json` | `@larksuiteoapi/node-sdk`: `^1.59.0` → `^1.61.0` | 低（单行版本号） |
| `bin/arc-bot.js` | USAGE 加 1 行；新增 `case 'feishu-qr'`（动态 import + try/catch） | 低（独立 case 块） |
| `lib/setup-wizard.js` | **仅**飞书分支（原 43–50 行）：先问「扫码 / 手动」，扫码失败自动回落手动 | 中（替换了一整个 if 块） |

`src/feishu.js`、`src/main.js`、`src/runners/*`、`lib/config.js` **完全没动**。

---

## 6. 与 dsh-im 的关系（别误传）

| 能力 | dsh-im 怎么做的 | 这里怎么做 |
|---|---|---|
| 扫码创建 | `registerApp` + `RegistrationManager` 状态机 + 多 bot 管理 | 直接用 `registerApp`，单 bot，不引状态机 |
| 应用头像 | **没有实现**（全仓无相关代码，`avatarUrl` 只是消息发送者头像透传） | 按 SDK 的 `appPreset.avatar` 能力**新实现** |
| "/" 快捷指令 | `slash-command-panel.mjs` + `slash-command-registry.mjs`，支持 100 条 + 自定义面板 | 只注册 `/clear`，复用 ARC 已有的命令解析 |

也就是说：**头像这块不是「参考 dsh-im」，而是 dsh-im 里根本没有**。这里如实标注，免得后人对错账。

---

## 7. 已知限制

- **Lark 国际版不可用**：`src/feishu.js` 用 `Lark.Domain.Feishu` 写死了中国版。
  扫码检测到国际版账号时会提示，但后续收发消息仍需改代码支持。
- **扫码创建的应用需要发布审批**，权限才生效。这一步必须人工去后台点。
- **头像创建后改不了**（见 §3.2）。
- 一个应用一套凭据，**不支持多租户**。ARC 本身是单用户工具，够用。
- `--force` 重新扫码会**覆盖**旧凭据，旧应用不会被删除（留在你的开发者后台，需手动清理）。

---

## 8. 排错

| 现象 | 原因 / 处理 |
|---|---|
| `不提供 registerApp` | SDK 版本 < 1.61.0。`npm install @larksuiteoapi/node-sdk@^1.61.0` |
| `ENOTFOUND feishu` | `domain` 传成了简写。已修，若再出现检查是否传了自定义主机名 |
| 二维码糊成一团 | 终端太窄。拉宽窗口，或扫 `~/.arc-bot/feishu-qr.png` |
| 扫完码机器人不说话 | 应用没发布审批；或事件订阅不是长连接 |
| 快捷指令面板是空的 | 缺 `application:app_slash_command:write`；补权限后 `--force` 重跑 |
| 头像不显示 | URL 不是公网可达，或飞书服务器访问不了该域名 |

---

## 9. 验证状态（诚实版）

| 项 | 状态 |
|---|---|
| `begin` 请求 + 二维码生成 + PNG 有效 | ✅ 已实测（真实请求 accounts.feishu.cn） |
| 终端二维码列宽自适应、非 TTY 不画码 | ✅ 已实测 |
| 参数校验（非法 domain / avatar / 未知参数）| ✅ 已实测，退出码 1 |
| **扫码成功后拿到 client_id/secret** | ❌ 未实测（需真人扫码） |
| **"/" 快捷指令真实注册** | ❌ 未实测（需真实 app 凭据） |
| **`appPreset.avatar` 真实生效** | ❌ 未实测（需公网图床） |

未实测的三项都需要一个真实的飞书企业账号和一个已发布的 app，无法在 CI 里覆盖。
