# Filo：给 Agent 的说明

## 核心思想：TUI 和 GUI 同构

Filo 不是另一个 agent，而是 pi 的第二张脸。终端里的 pi（配 pi-cc-tui）和 Filo 里的 pi 是同一个东西：同一份会话、同一份配置、同一套能力，只是渲染不同。用户可以随时在两边切换，不丢任何东西，也不用学两套用法。

判断一个改动对不对，先问：**这件事在终端的 pi 里是什么样？** 如果答案是"终端里没有"或"终端里不一样"，要么让两边一样，要么把这个差异写进下面的"例外"。

### 现在已经同构的部分

- **会话**：只有 pi 自己的 JSONL（`~/.pi/agent/sessions`）。Filo 不另存对话，终端里跑的会话会出现在项目树里，也能被搜索。
- **配置**：模型、供应商、登录写进 pi 自己的 `~/.pi/agent`（`settings.json`、`models.json`、`auth.json`），扩展用它们自己的配置文件（比如 `web-search.json`），两边读的是同一份。
- **能力**：`packages/capabilities` 是一份实现、两个宿主。Filo 用 `-e` 按线程加载，pi-cc-tui 在终端里加载同一份代码。扩展按 `ctx.mode` 分渲染方式：`rpc` 时发状态、等隐藏的 `/gui-…` 命令；`tui` 时画 Claude Code 风格的对话框。
- **新会话用哪个模型**：每个 agent 都从它自己配置里的默认开始，Filo 不另记。在 pi 线程里选模型、思考强度，就是 pi 的 TUI 里选中后按 Ctrl+S：这个会话换过去，同时和它一样写 `settings.json` 的 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`（有 `enabledModels` 且没列这个模型时把它补上；路由组不写，终端里的 pi 没有这个供应商），见"例外"；模型菜单里的「默认」标记按线程的项目读，即全局 `settings.json` 合并项目的 `.pi/settings.json`，和 pi 一样只在项目受信任时合并（`agentDir/trust.json` 里最近的祖先目录说了算，没有就看 `defaultProjectTrust`；`electron/piSettings.ts` 的 `settingsFor`）。Codex 的确认和沙箱也从 `config.toml` 开始：线程报告的 `approval_policy`、`sandbox` 就是起点，在线程里选了预设才在 `turn/start` 里覆盖，和它 TUI 里的 `/approvals` 一样只管这个会话；Codex 的 `/model` 会写回 `config.toml`，Filo 也通过 app-server 的 `config/batchWrite` 写回 `model` 和 `model_reasoning_effort`；ACP agent 交给它自己的 `session/set_model`。线程里选的只在这个线程重启时恢复（会话还没存下来的时候）。
- **项目信任**：项目带了 `.pi` 里的设置、扩展等资源而 pi 还没记过选择时，pi 的 TUI 启动前会问一次；RPC 没有界面，不问就当不信任。所以 Filo 的 pi 启动前在线程里问同一个问题（同样的标题和选项，`electron/providerHelper.mts` 的 `trustQuestion`），存下来的选择用 pi 自己的 `ProjectTrustStore` 写进 `agentDir/trust.json`，「仅本次会话」的答案用 `--approve` / `--no-approve` 只给这个线程。`defaultProjectTrust` 不是 `ask` 时和 pi 一样不问。
- **开哪些能力、新会话的确认模式**：存在 `~/.pi/agent/settings.json` 的 `"pi-capabilities"` 键（`packages/capabilities/lib/catalog.ts` 的 `SETTINGS_KEY`，读写在 `lib/settings.ts`）。Filo 的设置页和 pi-cc-tui 的 `/capabilities` 改的是同一份，在线程里切确认模式也写回 `approvalMode`，两边一样（子 agent 的不写，它的模式来自父 agent 的环境变量）；Filo 监视这个文件，终端里改了，Filo 的空闲线程会重启。
- **输入和队列**：和 pi 的 TUI 一样：运行中 Enter 引导（steer），Alt+Enter 排到这轮之后（follow-up），Alt+Up（Windows 上 Alt+Q）把整个队列撤回输入框，pi 只能整队撤回，所以每条上的按钮也是整队撤回；压缩时输入的先留着，压缩完按原来的方式发出（`src/store/thread.ts` 的 `compactionQueue`）。`!cmd` 和 `!!cmd`（不进模型上下文）走 pi 的 RPC `bash`，和 TUI 一样立刻跑（运行中、压缩中也是），输出流式显示，Esc 取消，结果记进会话。加入终端里的 pi 时也一样：cc-bridge 在 `user_bash` 里接过执行（用 pi 自己的 shell 设置），把输出流给 Filo（Filo 连着时，排在它后面的扩展的 `user_bash` 不再生效），Esc 换成 TUI 自己的取消；队列跟着终端里的变化发 `queue_update`。
- **会话名**：只有 agent 自己能改名时才给改（pi 的 `set_session_name`、Claude Code 的 `/rename`、Codex 的 `thread/name/set`、Grok 的 `_x.ai/session/rename`），Filo 不另记名字，fork 出来的也不起名。
- **契约**：`packages/capabilities/protocol.ts` 是两边唯一的约定，包括命令名、状态 key、事件名、环境变量，以及工具结果里 `details` 的类型。`details` 会写进会话文件，所以两边读到的是同一份结构。
- **同一个进程**：装了 pi-cc-tui 时，Filo 通过 bridge socket 加入终端里正在跑的那个 pi，而不是另起一个。approval、ask、plan 会在两边同时弹出，先答的一边会关掉另一边（`DIALOG_EVENTS`）。别的扩展也一样：cc-bridge 包住所有扩展共用的 `ctx.ui`，`select`、`confirm`、`input` 在两边同时弹出、先答的算，状态、通知、文字 widget 按 RPC 模式的格式发给 Filo，后加入的会补上。Filo 发来的输入就像在终端里敲的：cc-bridge 包住 TUI 的编辑器，走它自己的 Enter（`onSubmit`）、Alt+Enter、Alt+Up，所以 `!cmd`、压缩时暂存、输入历史都是终端那一套；终端里正在打的草稿不动；图片写成 pi-clipboard 文件，由 cc-input 当粘贴的图片附上。扩展命令（包括隐藏的 `/gui-…`）不进编辑器，直接 `sendUserMessage`。
- **Claude Code 和 Codex 的渠道**：渠道库就是供应商：一个地址加 key，所有 agent 共用，存在 pi 的 `models.json` 和 `auth.json`。每个模型有自己的接口（`api`），pi 都能用，Claude Code 用 Anthropic Messages 的，Codex 用 OpenAI Responses 的。同一个地址和 key 只存成一个供应商：从另一个 agent 再加一次，是往同一个里补模型，pi 认得的模型用它原厂的接口，其余用添加它的 agent 的。订阅登录只给 pi 用。选中的渠道写进它们自己的 `settings.json`（`CLAUDE_CONFIG_DIR`）和 `config.toml`（`CODEX_HOME`），和 cc-switch 一样，终端里的 `claude`、`codex` 读的是同一份，关了 Filo 也不变（`electron/gateway/channel.ts`，写入只在 `RoutesService`）。当前渠道每次从文件里读，Filo 的线程启动时只加一处覆盖：在 Filo 设的渠道上，线程的请求改走本地网关，好给缓存保温（见"例外"），网关把请求原样转给这个渠道，Codex 用的仍是这个渠道自己的 `pi-…` 表。切渠道只重启选它的那个线程，其他线程保持启动时的渠道。第一次写之前的值记在 `userData/routes.json`，能换回去。供应商的 key 改了，配置里的副本跟着重写。Codex 续接会话时，如果配置没写 `model_provider`，就用会话记录的那个，所以 `[model_providers."pi-…"]` 表在换回后也保留：在渠道上开的 Codex 会话换回后仍在那个渠道上（终端里 `codex resume` 也一样），想换就开新线程。
- **斜杠命令**：Filo 不模拟 pi 的编辑器命令，输入框里敲 `/` 没有菜单也不拦截，文字原样发给 agent。pi 的 `/compact`、`/model`、`/name`、`/tree`、`/fork`、`/clone`、`/export`、`/session`、`/reload`、`/hotkeys`、`/trust`、`/new`、`/resume`、`/settings`、`/login`、`/copy` 等在界面里各有入口（压缩按钮、模型选择器、标签右键菜单、回答上的「回到这里」、设置页……），对应关系在 `src/lib/guiCommands.ts`（一份清单，每条写着对应的界面）。技能、提示模板、扩展命令、agent 自己报告的命令是开放集合，进输入框工具栏的「技能」选择器（⌘/，`src/features/Composer/CommandPicker.tsx`）：选中后是输入框上的一个标签，发送时拼成 `/名字 参数` 文字，和终端里同一份。选择器里不列清单上已有界面的命令。Claude Code 不报告命令表，选择器读它的 skills 和 commands 目录（`electron/native/claudeCommands.ts`，只读）；Codex 没有命令表，不显示按钮。`packages/capabilities/extensions/builtins.ts` 只留 GUI 自己调的 `gui-rewind`、`gui-rewind-to`、`gui-clone`、`gui-reload`。终端里的 pi 不受影响，`/` 命令照旧。
- **副本（worktree）**：就是 git 自己的 linked worktree，Filo 不另记。项目是不是副本、属于哪个项目，每次从 git 推导（`electron/git.ts` 的 `worktreeParent`），所以终端里 `git worktree add`、`claude --worktree` 开的也会挂在原项目下。Filo 建的放在 `~/.filo/worktrees`，detached HEAD，不建分支。「应用」把副本相对分叉点的全部改动（提交、编辑、新文件）三方合并成主目录里未暂存的改动，两边的真 index 都不动；终端里对应的就是 `git diff` 加 `git apply --3way`。
- **技能**：就是各家自己的 skills 目录，Filo 不另记。`~/.agents/skills` 是共用的那份，pi、Codex、OpenCode、Grok 都读；Claude Code 只读 `CLAUDE_CONFIG_DIR/skills`，所以共享的技能在那里放一个链接（`electron/skills.ts`）。设置页「技能」每次从目录里读：同名算一个技能，链接也算。「共享」把只在某家目录里的挪进 `~/.agents/skills`，指向它的链接跟着改；同名但内容不同的几份不动，列出路径让用户留一份。终端里对应的就是 `mv` 加 `ln -s`。只管用户级的，项目里的 `.agents/skills`、`.claude/skills` 跟着仓库走。MCP 不统一，各家用各家的文件：设置页「Claude Code」读它的 `.claude.json` 和项目的 `.mcp.json`，增删走用户自己的 `claude mcp add|remove`；设置页「Codex」读写 `config.toml` 的 `[mcp_servers]`（app-server 的 `config/batchWrite`）。两页还各有记忆开关（Claude Code 的 `autoMemoryEnabled`）和实验功能开关（Codex 的 `features.<name>`），终端里的 `/mcp`、`/memory`、`/experimental` 改的是同一份。pi 1.0.4 起内置 MCP（`/mcp`、`.pi/mcp.json`），Filo 还没有对应界面。项目说明也不用 Filo 管：Claude Code 在项目没有 CLAUDE.md 时自己读 AGENTS.md（`instructionFiles`）。
- **外观和用词**：工具标题、调用摘要跟 pi 的 TUI 和 pi-cc-extensions 保持一致（`src/lib/toolMeta.ts`）。

### 写新东西时

- **需要 agent 配合的功能，写成 `packages/capabilities` 里的 pi 扩展**，两种模式都要做，不要写成只在 `electron/` 里的逻辑。只做 GUI 一边的，要在"例外"里写明原因。
- **状态放在 pi 那边**：会话条目、自定义 entry、`~/.pi/agent` 下的文件。Filo 私有的状态（`userData` 下）只放纯界面的东西，比如窗口、标签页、面板宽度。判断标准是：删掉 Filo 回到终端，用户会不会丢东西。
- **配置复用 pi 和扩展自己的配置文件和键名**，不要另起一套再去同步。
- **工具名、参数和结果格式两边一致**。GUI 可以把结果渲染得更好看，但不能让模型在两边看到不同的东西。
- **引入社区的 pi 扩展时，用 `pi install` 装进 `~/.pi/agent`，不要打包进 Filo**：这样终端里的 pi 也有，配置文件也共用一份（见 `electron/piPackages.ts` 和设置页的「联网搜索」）。安装只在用户点了之后跑，版本固定。
- **测试走真的 pi**：`test/harness.ts` 用 Filo 的 `AgentManager` 启动真实的 `pi --mode rpc`，配一个模拟模型。终端那一侧的测试见 `test/terminal-e2e.ts`、`test/bridge.test.ts`，需要 tmux。

### 例外（有意不同构，新增时写在这里）

- **pi 的编辑器命令在 Filo 里是界面，不是 `/` 命令**：终端里 `/compact`、`/tree` 这类在 Filo 里是按钮和菜单（见"斜杠命令"一条）。在 Filo 输入框里敲它们，是发给模型的普通文字。想在终端里用就在终端里用。Codex / Grok 敲 `/compact` 同理，agent 自己怎么处理就怎么处理，Filo 不加进度行。

- **Claude Code 和 Codex 的缓存保温**：保温要有个进程在空闲时重发请求，所以只在 Filo 开着、线程在 Filo 里跑时有效（`electron/gateway/warm.ts`），做法和 pi 自己的一样：同一个 `cacheWarming` 设置、同样的时机、上限和划算判断。只对 Filo 设的 API key 渠道（含中转），订阅不保温，网关手里也没有订阅的凭据。保温请求的花费显示在线程里，但不在 agent 自己的会话记录里，所以 `/cost` 和花费面板不算它。
- **Claude Code 和 Codex 的预算和卡住提醒**：只在 Filo 里，只提醒不打断（`src/store/thread.ts` 的 `checkSpend`、`checkStall`）。pi 的 `budget` 能力在两边都会拦。
- **路由组**：失败切换要有个进程夹在中间，所以只在 Filo 开着时有效（`electron/gateway`）。「终端同步」只在 Filo 运行时把终端 agent 的配置指向网关，退出时还原。要在终端里固定用一个供应商，选渠道。
- **`terminal` 能力**：依赖 Filo 底部的终端面板和它的 socket，终端里的 pi 没有对应物。pi-cc-tui 不加载它。
- **`browser` 能力（浏览器面板）**：和 `terminal` 一样依赖 Filo 自己的面板和 socket（`PI_KIT_BROWSER`），终端里的 pi 没有对应物，pi-cc-tui 不加载它。页面是盖在右侧面板上的原生 `WebContentsView`（`electron/browsers.ts`，常驻分区 `persist:filo-browser`，登录会保留；无 preload、沙箱、权限默认拒绝、下载取消、只放行 http/https/file），agent 通过 CDP（`electron/browserDriver.ts`）读无障碍树、发真实输入、截图；每个 pi 会话有自己的标签页，用户的标签页 agent 能读能操作但不能关。只有 pi 线程有，Codex、Claude Code 和 ACP agent 要走 MCP，还没做。`window.opener` 依赖的 OAuth 弹窗不支持。Cookie 在 `userData` 下，是 Filo 私有状态，终端里没有对应物。
- **ACP agent（Codex、Claude Code 等）**：会话归它们自己管，Filo 只是转成 pi 的事件来显示。
- **Claude Code 线程是它自己 TUI 的投影**（`electron/native/claudeTui.ts`）。执行的是用户没改过的交互式 `claude`，跑在 Filo 持有的隐藏终端里，登录和计费跟用户在终端里一样。对话内容折叠自它的会话 JSONL，运行状态和权限请求来自 hooks（只上报，不做决定），GUI 的操作换成按键（prompt 是粘贴加回车，停止是 Esc，审批是对话框的数字键）。GUI 表达不了的状态（登录、信任目录、菜单、多题提问、终端里没发出去的输入）直接切到 TUI 本身。线程右上角可以随时在对话和终端之间切换。hooks 被用户或项目设置的 `disableAllHooks` 关掉时，线程切到 TUI，只靠读 JSONL 跟进对话，并提供「为 Filo 打开 hooks」：在 Filo 自己的 `--settings` 里写 `disableAllHooks: false`（优先级高于用户和项目设置），不改用户的文件，选择记在 `userData/claude-tui.json`。管理员策略关掉的打不开，只说明原因。设置里有 `allowedHttpHookUrls` 白名单时，所有 hook 改走 curl 命令。所以 Claude Code 线程不支持 fork、rewind、删除会话，这些在 TUI 里做。模型（Opus、Sonnet、Haiku 三个别名）和思考强度能在输入框里选：换成 `/model <别名>`、`/effort <级别>` 敲进 TUI，它写的也是用户的 `settings.json`，和终端里一样；对话已有历史时 Claude Code 会先问「Switch model?」，所以 GUI 先问一次，确认后替用户按 1。渠道另算，写的是 `settings.json` 的 env。
- **跨 agent 审查和交接**：一个 agent 审另一个 agent 的工作，或者接着做另一个 agent 没做完的（额度用完、卡住），跨了 agent，终端里没有对应物（终端里就是另开一个 agent 把任务贴过去）。审查者和接手的都是普通的新线程，会话是那个 agent 自己的，历史不搬，只给一份任务说明：和 pi 的 `review` 能力同一份事实（`lib/review.ts` 的 `branchFacts`，`electron/git.ts` 的 `threadTask` 从线程消息生成），审查用 `reviewerTask`，只是列出文件让它自己 diff、用文字回报告；交接用 `handoffTask`，放进新线程的输入框，不自动发。「发回」把报告放进被审查线程的输入框，由用户删减后发送。审查线程和被审查线程的对应只在内存里。
- **只有终端能画的对话框**：pi 的 `editor` 对话框和扩展的 `ui.custom`（自己画的组件）没法从外面回答，也没法序列化。加入终端里的 pi 时，Filo 只显示「去终端里回答」（`method: 'terminal'`）。ask、plan 这类自己有 GUI 版本的能力不受影响。
- **加入终端 pi 时的项目信任**：终端里的 pi 启动时就问过了，那时 bridge 还不存在，Filo 看不到也答不了。加入时不再问（`pi:trust` 遇到正被 bridge 占着的会话返回空），存下来的选择是同一份 `trust.json`。
- **pi 线程里选模型就设为默认**：pi 的 TUI 里 Enter 只换这个会话，Ctrl+S 才写进 `settings.json`；Filo 选了就写（`src/store/thread.ts` 的 `setModel`、`setThinkingLevel`），用户选了一个模型，下次开新线程还是它。写的是同一份默认，终端里新开的 pi 也从它开始。Filo 里没有 `/model`、`/thinking` 命令。
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
