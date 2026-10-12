# Filo：给 Agent 的说明

## 核心思想：TUI 和 GUI 同构

Filo 不是另一个 agent，而是 pi 的第二张脸。终端里的 pi（配 pi-cc-tui）和 Filo 里的 pi 是同一个东西：同一份会话、同一份配置、同一套能力，只是渲染不同。用户可以随时在两边切换，不丢任何东西，也不用学两套用法。

判断一个改动对不对，先问：**这件事在终端的 pi 里是什么样？** 如果答案是"终端里没有"或"终端里不一样"，要么让两边一样，要么把这个差异写进下面的"例外"。

### 现在已经同构的部分

- **会话**：只有 pi 自己的 JSONL（`~/.pi/agent/sessions`）。Filo 不另存对话，终端里跑的会话会出现在项目树里，也能被搜索。
- **配置**：模型、供应商、登录写进 pi 自己的 `~/.pi/agent`（`settings.json`、`models.json`、`auth.json`），扩展用它们自己的配置文件（比如 `web-search.json`），两边读的是同一份。
- **能力**：`packages/capabilities` 是一份实现、两个宿主。Filo 用 `-e` 按线程加载，pi-cc-tui 在终端里加载同一份代码。扩展按 `ctx.mode` 分渲染方式：`rpc` 时发状态、等隐藏的 `/gui-…` 命令；`tui` 时画 Claude Code 风格的对话框。
- **新会话用哪个模型**：每个 agent 都从它自己配置里的默认开始，Filo 不另记。在线程里选模型，效果和在那个 agent 的 TUI 里选一样：pi 只换这个会话，要改默认用模型菜单里的「设为新会话的默认」，写的是 `settings.json` 的 `defaultProvider`、`defaultModel`；Codex 的 `/model` 会写回 `config.toml`，Filo 也通过 app-server 的 `config/batchWrite` 写回 `model` 和 `model_reasoning_effort`；ACP agent 交给它自己的 `session/set_model`。线程里选的只在这个线程重启时恢复（会话还没存下来的时候）。
- **开哪些能力、新会话的确认模式**：存在 `~/.pi/agent/settings.json` 的 `"pi-capabilities"` 键（`packages/capabilities/lib/catalog.ts` 的 `SETTINGS_KEY`，读写在 `lib/settings.ts`）。Filo 的设置页和 pi-cc-tui 的 `/capabilities` 改的是同一份；Filo 监视这个文件，终端里改了，Filo 的空闲线程会重启。
- **契约**：`packages/capabilities/protocol.ts` 是两边唯一的约定，包括命令名、状态 key、事件名、环境变量，以及工具结果里 `details` 的类型。`details` 会写进会话文件，所以两边读到的是同一份结构。
- **同一个进程**：装了 pi-cc-tui 时，Filo 通过 bridge socket 加入终端里正在跑的那个 pi，而不是另起一个。approval、ask、plan 会在两边同时弹出，先答的一边会关掉另一边（`DIALOG_EVENTS`）。
- **Claude Code 和 Codex 的渠道**：渠道库就是供应商：一个地址加 key，所有 agent 共用，存在 pi 的 `models.json` 和 `auth.json`。每个模型有自己的接口（`api`），pi 都能用，Claude Code 用 Anthropic Messages 的，Codex 用 OpenAI Responses 的。同一个地址和 key 只存成一个供应商：从另一个 agent 再加一次，是往同一个里补模型，pi 认得的模型用它原厂的接口，其余用添加它的 agent 的。订阅登录只给 pi 用。选中的渠道写进它们自己的 `settings.json`（`CLAUDE_CONFIG_DIR`）和 `config.toml`（`CODEX_HOME`），和 cc-switch 一样，终端里的 `claude`、`codex` 读的是同一份，关了 Filo 也不变（`electron/gateway/channel.ts`，写入只在 `RoutesService`）。当前渠道每次从文件里读，Filo 的线程启动时只加一处覆盖：在 Filo 设的渠道上，线程的请求改走本地网关，好给缓存保温（见"例外"），网关把请求原样转给这个渠道，Codex 用的仍是这个渠道自己的 `pi-…` 表。切渠道只重启选它的那个线程，其他线程保持启动时的渠道。第一次写之前的值记在 `userData/routes.json`，能换回去。供应商的 key 改了，配置里的副本跟着重写。Codex 续接会话时，如果配置没写 `model_provider`，就用会话记录的那个，所以 `[model_providers."pi-…"]` 表在换回后也保留：在渠道上开的 Codex 会话换回后仍在那个渠道上（终端里 `codex resume` 也一样），想换就开新线程。
- **外观和用词**：工具标题、调用摘要跟 pi 的 TUI 和 pi-cc-extensions 保持一致（`src/lib/toolMeta.ts`）。

### 写新东西时

- **需要 agent 配合的功能，写成 `packages/capabilities` 里的 pi 扩展**，两种模式都要做，不要写成只在 `electron/` 里的逻辑。只做 GUI 一边的，要在"例外"里写明原因。
- **状态放在 pi 那边**：会话条目、自定义 entry、`~/.pi/agent` 下的文件。Filo 私有的状态（`userData` 下）只放纯界面的东西，比如窗口、标签页、面板宽度。判断标准是：删掉 Filo 回到终端，用户会不会丢东西。
- **配置复用 pi 和扩展自己的配置文件和键名**，不要另起一套再去同步。
- **工具名、参数和结果格式两边一致**。GUI 可以把结果渲染得更好看，但不能让模型在两边看到不同的东西。
- **引入社区的 pi 扩展时，用 `pi install` 装进 `~/.pi/agent`，不要打包进 Filo**：这样终端里的 pi 也有，配置文件也共用一份（见 `electron/piPackages.ts` 和设置页的「联网搜索」）。安装只在用户点了之后跑，版本固定。
- **测试走真的 pi**：`test/harness.ts` 用 Filo 的 `AgentManager` 启动真实的 `pi --mode rpc`，配一个模拟模型。终端那一侧的测试见 `test/terminal-e2e.ts`、`test/bridge.test.ts`，需要 tmux。

### 例外（有意不同构，新增时写在这里）

- **Claude Code 和 Codex 的缓存保温**：保温要有个进程在空闲时重发请求，所以只在 Filo 开着、线程在 Filo 里跑时有效（`electron/gateway/warm.ts`），做法和 pi 自己的一样：同一个 `cacheWarming` 设置、同样的时机、上限和划算判断。只对 Filo 设的 API key 渠道（含中转），订阅不保温，网关手里也没有订阅的凭据。保温请求的花费显示在线程里，但不在 agent 自己的会话记录里，所以 `/cost` 和花费面板不算它。
- **Claude Code 和 Codex 的预算和卡住提醒**：只在 Filo 里，只提醒不打断（`src/store/thread.ts` 的 `checkSpend`、`checkStall`）。pi 的 `budget` 能力在两边都会拦。
- **路由组**：失败切换要有个进程夹在中间，所以只在 Filo 开着时有效（`electron/gateway`）。「终端同步」只在 Filo 运行时把终端 agent 的配置指向网关，退出时还原。要在终端里固定用一个供应商，选渠道。
- **`terminal` 能力**：依赖 Filo 底部的终端面板和它的 socket，终端里的 pi 没有对应物。pi-cc-tui 不加载它。
- **ACP agent（Codex、Claude Code 等）**：会话归它们自己管，Filo 只是转成 pi 的事件来显示。
- **Claude Code 线程是它自己 TUI 的投影**（`electron/native/claudeTui.ts`）。执行的是用户没改过的交互式 `claude`，跑在 Filo 持有的隐藏终端里，登录和计费跟用户在终端里一样。对话内容折叠自它的会话 JSONL，运行状态和权限请求来自 hooks（只上报，不做决定），GUI 的操作换成按键（prompt 是粘贴加回车，停止是 Esc，审批是对话框的数字键）。GUI 表达不了的状态（登录、信任目录、菜单、多题提问、终端里没发出去的输入）直接切到 TUI 本身。线程右上角可以随时在对话和终端之间切换。hooks 被用户或项目设置的 `disableAllHooks` 关掉时，线程切到 TUI，只靠读 JSONL 跟进对话，并提供「为 Filo 打开 hooks」：在 Filo 自己的 `--settings` 里写 `disableAllHooks: false`（优先级高于用户和项目设置），不改用户的文件，选择记在 `userData/claude-tui.json`。管理员策略关掉的打不开，只说明原因。设置里有 `allowedHttpHookUrls` 白名单时，所有 hook 改走 curl 命令。所以 Claude Code 线程不支持 fork、rewind、删除会话、选模型（渠道除外，它写的是 `settings.json`），这些在 TUI 里做。
- **设置向导和默认 agent**：只存在 Filo 的 `state.json`（`defaultAgent`、`setupDone`）。它决定的是 Filo 新线程用谁，终端里没有对应的选择。向导装的东西本身不是例外：Node、pi、各家 CLI 都用官方安装程序装到系统里，终端和 Filo 用的是同一份。

## 核心原则：Filo 是入口，不做适配黑盒

Filo 控制用户从哪里进来：选哪个 agent、哪个模型，都由用户在线程开始时自己选。所以 Filo 不需要像纯网关（比如 magpie）那样，靠改写请求、冒充客户端、转借凭据来让一个 agent 用上另一家的东西。

- **线程开始时选定 agent，有历史后不再切换**。不同厂商的历史不能无损交接：GPT 的 reasoning 密文、Claude 的 thinking 签名、各家的工具调用格式都对不上，硬接就得写一堆剥离、改写、重放的适配逻辑，出了问题谁也说不清。想换 agent 就开新线程。模型（包括路由组）可以在线程里换，但 Filo 不碰历史：pi 自己换模型，其他 agent 换组是重启后由 agent 自己续接会话，新供应商不认旧历史就原样报错，不做修补。
- **订阅只给它自己的 agent 用**。Claude 订阅就开 Claude Code 线程，ChatGPT 订阅就开 Codex 线程。不冒充官方客户端，不把订阅凭据转给别的 agent，不重放 OAuth token，也不碰厂商的非公开后端。
- **路由网关只管 API key 和兼容接口的中转**。组成员来自用户自己填了 key 的供应商，订阅登录的供应商不进组（`routeCatalog` 跳过它们）。
- **组内失败切换只在 agent 还没收到任何输出时发生，而且不修补请求**。对话中途换到另一家时，不剥密文、不改历史，对方拒绝就把错误原样报给 agent。一个线程已经由某个成员回答过，就尽量一直用它。组里最好放同一个模型的不同渠道。
- **判断标准**：一个功能如果要靠猜测厂商的内部行为才能工作，或者厂商改一下规则就会坏、甚至让用户的账号有风险，就不做。例外是**只读**地读 agent 自己的本地文件（比如列出终端里开的会话）：不碰账号，格式不认识就跳过，坏了只是列表里少几条（`electron/acp/cliSessions.ts`）。

## 各 agent 的会话

历史都是 agent 自己原生的那一份，续接时由 agent 自己读。Filo 只记一份会话目录（`userData/acp-sessions.json`：id、cwd、标题、时间）和一份给搜索用的 pi 格式副本（`userData/acp-transcripts`），续接从不读副本。

「终端会话」指用户在终端里直接跑 CLI 开的对话。只显示 cwd 是 Filo 里已有项目的会话，列表每 2 分钟最多重读一次。下表是 2026-10-09 在这些版本上实测的，标「未核实」的没试过。

| agent（版本） | 怎么列出会话 | 终端会话能看到 | 在 Filo 里接着聊 | 备注 |
|---|---|---|---|---|
| pi | 扫 `~/.pi/agent/sessions` | 能 | 能 | 同一份 JSONL，装了 pi-cc-tui 还能加入正在跑的进程 |
| Codex（0.160.1） | app-server `thread/list` | 能 | 能（`thread/resume`） | 列 cli、vscode、exec、appServer、unknown 几种来源；Codex 桌面 app 开的算不算在内，未核实 |
| Claude Code（2.1.289） | 读 `~/.claude/projects/*/*.jsonl`（遵守 `CLAUDE_CONFIG_DIR`） | 能 | 能（`claude --resume`） | 跑的是用户自己的交互式 `claude`，订阅或 API key 由它自己的 `/login` 决定。`claude -p` 等非交互入口开的会话不列 |
| Grok Build（1.0.46） | ACP `session/list` | 能 | 能 | |
| OpenCode（1.18.34，用户自己装的；固定版本 1.18.35） | ACP `session/list` | 能 | 能 | 不登录也能用 OpenCode Zen 的免费模型（如 `opencode/big-pickle`）。Filo 里续写的消息写回同一个会话，终端 `opencode` 能看到 |
| GitHub Copilot（1.0.92） | ACP `session/list` | 能 | 能 | 不登录也能列，但开不了会话 |
| Cursor（2026.10.01） | ACP `session/list` + 读文件 | 能，只读 | ACP 开的能；终端开的不能 | ACP 只认 `~/.cursor/acp-sessions`。终端对话在 `~/.cursor/chats/<md5(cwd)>/<id>/meta.json` 和 `~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl`，`session/load` 拒绝（Invalid params）。线程里没有输入框，「在终端里继续」跑 `cursor-agent --resume <id>`。记录里没有工具结果和逐条时间 |
| Gemini CLI（0.63.0） | 读文件 | 能 | 能（`session/load`） | 没有 `session/list`。会话在 `~/.gemini/tmp/<项目>/chats/session-*.jsonl`，项目路径在同目录的 `.project_root`（真实路径，`/tmp` 会是 `/private/tmp`）。回放时第一条用户消息是它自己的 `<session_context>`，要滤掉 |

换版本后要重测的：`bun run e2e:cli-sessions`（Cursor 和 Gemini，假模型、临时 HOME，不用账号）、`bun run e2e:claude-tui`（真 `claude`，假 Anthropic 接口、临时 `CLAUDE_CONFIG_DIR`），其余靠真账号手动试。

## 仓库地图

见 `README.md` 的 "How it works"。能力扩展的清单和各自的命令见 `packages/capabilities/README.md`。

## 验证

- 类型检查：`bun run typecheck`（即 `tsc -b`，不要用 `--noEmit`）。
- 单测和端到端：`bun run test`（vitest）。`bun run e2e:*` 会驱动构建好的 app。
- 设置向导：`test/setup-e2e.ts` 用假的 HOME 和替身安装程序跑完整流程。e2e 默认带 `PI_GUI_SKIP_SETUP=1`（`test/app.ts` 的 `TEST_ENV`），不然每次启动都先进向导。真实安装程序只在干净的虚拟机里试过（mac-vm），不要在开发机上点。
- 联网搜索的端到端测试要下载包，默认不跑：见 `test/web-access.test.ts` 开头和 `test/capabilities-e2e.ts`（`PI_GUI_NETWORK_E2E=1`）。
