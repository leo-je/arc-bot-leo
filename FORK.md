# Fork 说明与变更记录

## 关于本 fork

- **上游仓库**：[wo6x5a/arc](https://github.com/wo6x5a/arc)
- **上游 npm 包**：`arc-bot`（maintainer 为上游作者，本 fork 无权发布）
- **本仓库**：[leo-je/arc-bot-leo](https://github.com/leo-je/arc-bot-leo)
- **本 fork 的 npm 包**：`arc-bot-leo`
- **分叉基线**：上游 `v1.1.1`（commit `bc2363a`）

分叉原因：原项目只支持 Telegram / WhatsApp / 钉钉，本 fork 补齐了**飞书**这条线——包括扫码创建机器人、卡片流式渲染、`/` 快捷指令面板。

---

## 安装

```bash
npm install -g arc-bot-leo
arc-bot-leo start
```

---

## 破坏性变更（1.1.7）

从上游 `arc-bot` 迁到 `arc-bot-leo` 时，除了命令名，以下运行时位置也一并改名，以免同机安装两个包时互相踩踏：

| 项 | 上游 `arc-bot` | 本 fork `arc-bot-leo` |
|---|---|---|
| npm 包名 | `arc-bot` | `arc-bot-leo` |
| 命令行 | `arc-bot` | `arc-bot-leo` |
| 配置目录 | `~/.arc-bot/` | `~/.arc-bot-leo/` |
| 配置文件 | `~/.arc-bot/.env` | `~/.arc-bot-leo/.env` |
| PID 文件 | `~/.arc-bot/.arc.pid` | `~/.arc-bot-leo/.arc.pid` |
| 二维码临时图 | `~/.arc-bot/feishu-qr.png` | `~/.arc-bot-leo/feishu-qr.png` |
| PM2 进程名 | `arc-bot` | `arc-bot-leo` |

**从上游迁移**：

```bash
pm2 delete arc-bot                    # 先停掉旧的 pm2 进程
pm2 kill                              # 再停掉 pm2 守护进程（原因见下）
npm uninstall -g arc-bot
mv ~/.arc-bot ~/.arc-bot-leo          # 保留已配置的凭据，不用重扫二维码
npm install -g arc-bot-leo
arc-bot-leo start
```

> **`pm2 kill` 不能省**：如果 pm2 守护进程是从旧的全局包启动的，它的 fork 入口还指着
> `…/node_modules/arc-bot/node_modules/pm2/lib/ProcessContainerFork.js`。卸载旧包后这个路径消失，
> 守护进程再 fork 子进程就会报 `MODULE_NOT_FOUND`，表现为 `pm2 status` 里进程 `errored`、
> `pid 0`、重启计数一直涨。杀掉守护进程用新包重新拉起即可。

> 如果 `mv` 时提示目录不存在，说明还没配置过，直接 `arc-bot-leo start` 走向导即可。

---

## 变更记录

### 1.1.7

- **改名**：包名、命令行、配置目录、PM2 进程名统一为 `arc-bot-leo`（见上表）。
- README 头部补充 fork 来源说明，新增本文件作为变更记录。

### 1.1.6

- 合入飞书全部能力，打 tag `v1.1.6` 并在 GitHub Release 附带打包产物。
- 修 Node 22 下 `npm test` 找不到测试文件的问题（`node --test` 传目录在 22 上被当模块解析）。

### 1.1.5

- 新增 `"/"` 快捷指令面板：按 `SLASH_COMMANDS` 清单注册 12 条（`ai` / `model` / `steps` / `clear` / `stop` / `status` / `projects` / `cd` / `test` / `screenshot` / `tunnel` / `help`）。
- `feishu-qr` 新增 `--slash`（增量补齐）与 `--rebuild`（全删重建，用于摆正面板顺序）。
- 修一处解析错误：`client.request()` 返回的已经是业务体 `{code,data,msg}`，不是 axios response，原先按 `res.data` 取值导致命令清单恒为空、每次启动都重复建命令。

### 1.1.4

- 新增执行过程折叠面板：工具调用实时显示在回答上方的 `collapsible_panel` 里，任务结束时自动收起。
- 新增 `/steps off|card|text` 动态切换过程展示方式。
- `/ai` 支持直接带参数切换后端：`/ai claude`、`/ai gemini`、`/ai qwen`、`/ai codex`。

### 1.1.3

- 飞书回答改用**卡片流式渲染**（cardkit）替代纯文本分段发送：Markdown 正常渲染，回答不再被切成几十条消息。
- 新增 `feishuCard/` 模块。

### 1.1.2

- 新增 `feishuQr/` 模块：`feishu-qr` 命令扫码创建飞书自建应用，自动回填 App ID / App Secret / 白名单 open_id，并预置所需权限。
- `config` 向导的飞书分支增加「扫码 / 手动」二选一，原有手动输入方式保留不变。
- 修 `claude-runner`：新版 Claude Code 是原生二进制（Mach-O/ELF），旧代码用 `node <二进制>` 启动会抛 `SyntaxError: Invalid or unexpected token`；改为按文件头魔数判断启动方式。

---

## 与上游保持可合并

新增功能尽量收敛在独立目录，对上游既有文件的改动只有几处挂载点：

| 目录 | 内容 |
|---|---|
| `feishuQr/` | 扫码创建应用、快捷指令注册、头像处理 |
| `feishuCard/` | 卡片流式渲染、过程折叠面板 |

对上游文件的改动：

| 文件 | 改动 |
|---|---|
| `package.json` | 包名/命令名、`@larksuiteoapi/node-sdk` 下限提到 `^1.61.0`（`registerApp` 自该版本起提供）、新增 `test` 脚本 |
| `bin/arc-bot-leo.js` | 新增 `feishu-qr` 子命令 |
| `lib/setup-wizard.js` | 飞书分支增加「扫码 / 手动」选择 |
| `lib/config.js` | 配置目录改名 |
| `lib/pm2-manager.js` | PM2 进程名改名 |
| `src/feishu.js` | 回答走卡片流式；`/ai <后端>`、`/steps` 命令 |
| `src/runners/claude-runner.js` | 原生二进制启动方式 |

`src/runners/*`（除 claude-runner）、`src/main.js` 的业务逻辑、`lib/*` 的其余部分均未改动。
