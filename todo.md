# TODO

怎么用这个文件：待做的事先写在这里再动手，做完一项勾掉并写上 commit。新想法先记进来。每项写清背景、要做什么、怎么算做完、不做什么，下一个 AI 只读这份就能接手。
（最近一次更新：`/compact` 修复已提交 `4d0216c`，下面 M1 之前的事实都以该提交为准。）

---

## 待做

**总方向（用户 2026-10 的决定，所有 M 项都服从它）：Filo 是 GUI，输入框里不再有斜杠命令这个概念。**
- 输入 `/` 不再弹菜单，也不拦截、不提示：敲什么，原样作为文字发给 agent。
- 以前靠 `/xxx` 才能做的事，每一件都有对应的 GUI（按钮、菜单、弹层、设置页）。没有对应 GUI 的，就**先做 GUI 再删命令**，不是留着命令。
- 唯一的例外不是例外，是同一个原则：技能、提示模板、扩展命令、各 agent 自己定义的命令是一个**开放的、用户自己会增加的集合**（`~/.agents/skills` 里加一个技能就多一项），没法为每一项预先画一个按钮。它们的 GUI 就是一个“技能与命令”选择器（见 M2-C）：按钮 + 可搜索列表，选中后在输入框里变成一个标签，发出去时底层仍是 `/skill:xxx` 这样的文字。**这是协议，不是用户界面**：模型在 TUI 和 GUI 里看到的是同一份文字（见 `AGENTS.md` “工具名、参数和结果格式两边一致”），pi 靠这段文字展开技能。
- 终端里的 pi 不受影响，保留它自己的 `/`。


### 对照总表：每个命令有没有具体的 GUI 替代（2026-10）

判定：**有**＝已有入口，直接删命令；**部分**＝入口在但能力不全，要补；**没有**＝要开发；**不做**＝写明理由。
数据来源要分清，别当成都实测过：
- pi：24 个内置命令（`Composer/index.tsx` 的 `PI_BUILTINS`），读代码。
- Claude Code 2.1.289：**实测**。用 `claude -p` 指向打不通的假地址，拿到 `system/init` 里的 `slash_commands`（不调用模型）。注意这是非交互模式的表，交互里才有的（`/resume` `/login` `/permissions` `/memory` `/exit` `/cost`→`/usage` 等）不在里面。
- OpenCode 1.18.34：**实测**，ACP 只上报 `init`、`review` 和技能。
- Codex 0.160.1：**不完整**。app-server 没有命令表，我只从二进制字符串里扫到 `status diff model review new resume fork compact mcp init rename clear exit skills theme title fast apps plugins memories personality experimental`，漏的和用途要用 Codex 文档或 TUI 核对。
- Grok 1.0.50：**没取到**。`grok acp` 起来后一直没应答（可能要先登录或等久一点）。只知道之前真机测过的 `compact`、`context`。
- Cursor、Gemini、Copilot：没装，**未验证**。

**pi（Filo 的 pi）**

| 命令 | 具体 GUI 替代 | 判定 |
|---|---|---|
| new / resume / settings / login / logout | 加号、⌘K 搜索、设置页、设置 → 供应商 | 有 |
| copy | 每条回答上的复制按钮 | 有 |
| name | 标签右键“重命名” | 有 |
| model / thinking | 输入框的模型、思考强度选择器 | 有 |
| fork | 标签菜单“分叉线程”；提问上的“从这里分叉”“再问一次” | 有 |
| quit | 关标签、关窗口 | 有 |
| compact | 状态栏数字（藏着）、标签菜单；**不能带“保留什么”** | 部分 → M2-B |
| export | 只有 `/export` | 没有 → M2（标签菜单加“导出 HTML”） |
| session | 状态栏只有用量、花费、速率、改动行数；没有路径、id、消息数 | 没有 → M2 |
| hotkeys | 快捷键散在 `App.tsx`、`platform.ts`，无列表 | 没有 → M2 |
| trust | 启动前会问一次，事后不能改 | 没有 → M2（设置里按项目改） |
| reload | 配置变了会自动重启，没有手动按钮 | 没有 → M2 |
| clone | “分叉线程”是从某条提问分，不是就地复制 | 没有 → M3 |
| tree | 只能回到提问之前；不能选回答、不能总结被丢弃的分支 | 部分 → M3 |
| scoped-models | 无（`enabledModels` 只被动补） | 没有 → M4（设置 → 模型的勾选列表） |
| import / changelog / bug | 无 | 没有 → M4，要不要做待你定 |
| share | 无；pi 的分享是上传第三方 | 不做（涉及隐私，要你明确同意，见 M4） |

**Claude Code**（来自实测的 init 表；技能类的 18 个如 `deep-research`、`design`、`verify`、`debug`、`simplify`、`code-review`、`loop` 等不在这里，进 M2-C 选择器）

| 命令 | 具体 GUI 替代 | 判定 |
|---|---|---|
| clear | 新线程（加号）。语义略不同：它清当前会话，我们开新的 | 有 |
| rename | 标签右键“重命名” | 有 |
| compact | 压缩按钮 | 部分 → M2-B |
| context / usage（`/cost` 被 Claude 改名为 `/usage`） | 状态栏只有总数；明细只能看 TUI | 没有 → M7-a 用量明细弹层 |
| model | **没有**。`AGENTS.md` 写明 Claude 线程不支持选模型（渠道除外）；`get_available_models` 返回空 | 没有 → M7-b |
| effort / fast | **没有**。`get_available_thinking_levels` 返回空 | 没有 → M7-b |
| init | 无 | 没有 → M1-B（做成按钮） |
| mcp | 无（pi 没有 MCP，`AGENTS.md` 说“MCP 不统一”） | 没有 → M7-c，先问要不要 |
| config / output-style / color / focus | Filo 设置页不改 Claude 自己的配置；这几项是 TUI 的外观 | 不做：属于它自己的终端外观，需要时切到线程右上角的终端视图 |
| agents / list-agents | GUI 能显示子 agent 的执行，不能管理定义 | 没有 → M7-c |
| reload-plugins / reload-skills | 设置 → 技能每次读目录，线程里没有“重载”按钮 | 没有 → M2 的重载按钮顺带做 |
| security-review | 它是技能式命令，没有预先画的按钮 | 进 M2-C 选择器 |
| autocompact | 压缩的自动开关；Filo 设置 → 压缩只管 pi | 没有 → M7-c |
| heapdump | 调试用 | 不做 |
| insights / recap / goal / team-onboarding / design-consent / design-revoke / auto-mode-setup | **我没核实这些的用途**，不能判定 | 先查再定（M7-c） |
| 交互里才有的（resume、login、permissions、memory、exit、diff…） | resume 搜索、设置、审批对话框、关标签、改动面板；memory 无 | 大多有；memory（改 CLAUDE.md）没有 → M7-c |

**Codex**（命令表不完整，见上）

| 命令 | 具体 GUI 替代 | 判定 |
|---|---|---|
| new / resume / fork / rename / clear / exit | 加号、⌘K、分叉、重命名、关标签 | 有 |
| diff | 改动面板按钮 | 有 |
| model | 模型选择器 | 有 |
| fast / 协作模式 / 审批模式 | 输入框旁的 `ConfigPickers`（Codex 的 mode、collaboration、fast 各一个菜单）和审批预设 | 有 |
| skills | 设置 → 技能 | 有 |
| compact | 压缩按钮 | 部分 → M2-B |
| status | 状态栏只有部分 | 部分 → M7-a 一并做 |
| init | 无 | 没有 → M1-B |
| review | Filo 的 review 会另起一个 agent，语义不同 | 不做（不映射，避免两个同名入口） |
| mcp / apps / plugins / memories / personality / experimental / theme / title | 无；有的是 Codex 的功能、有的是它 TUI 的外观 | 逐个核实后定（M7-c）；theme/title 属于 TUI 外观，倾向不做 |

**Grok、OpenCode、其他 ACP**

| 命令 | 具体 GUI 替代 | 判定 |
|---|---|---|
| compact（Grok） | 压缩按钮 | 部分 → M2-B |
| context（Grok） | 同 Claude Code 的 context | 没有 → M7-a |
| init、review（OpenCode） | init 做成按钮；review 不映射 | 没有 / 不做 |
| 技能（OpenCode 的 20 个） | M2-C 选择器 | 有（做完 M2-C） |
| new / resume / diff / model（Filo 叠加的） | 加号、⌘K、改动面板、模型选择器 | 有 |
| 其余（Cursor、Gemini、Copilot） | — | 未验证，装了再取命令表 |

**汇总**：真正“没有 GUI，要开发”的是——
1. M2-B 压缩按钮；M2 的导出、会话详情、快捷键面板、信任、重载按钮；M2-C 技能选择器；
2. M3 克隆线程、回到回答并可总结；M4 的 scoped-models（和你选的 import / changelog / bug）；
3. M7-a 用量明细（Claude / Grok / Codex 的 context、usage、status）；M7-b Claude Code 的模型、思考强度、fast 选择器；M7-c Claude Code 和 Codex 里 mcp、agents、memory 等，先逐个核实再定。

---

### GUI 做不到的（所以“全干掉”不是一刀切）

**1. 技术上做不到，兜底是“切到终端视图”**
- Claude Code 线程是它自己 TUI 的投影（`electron/native/claudeTui.ts`），只能读会话文件、发按键。fork、rewind、删除会话在它这边不支持（`AGENTS.md`）。
- 只在屏幕上画、不写会话文件也不触发钩子的输出（例如 `/usage`）：Filo 拿不到数据，现在切到终端视图。读屏幕文字太脆，**不做**，M7-a 里这一项只做能拿到数据的（`/context` 写文件）。
- Claude Code 的登录、信任目录、菜单、多题提问、终端里没发出去的输入：切到 TUI。
- pi 的 `editor` 对话框和 `ui.custom`，加入终端里的 pi 时只显示“去终端里回答”。
- Cursor 在终端里开的会话不能在 Filo 里接着聊（ACP 只认自己开的）。
- 管理员策略关掉 hooks 的 Claude Code：只说明原因。
**所以 M1-B 的验收改为**：Claude Code 允许有“切到终端”兜底的命令，其余都有 GUI。

**2. 能做但按原则不做**：订阅凭据转给别的 agent、非公开后端；中途换 agent；pi 的 share（上传第三方）；Claude 的 config / output-style / color / focus（它终端的外观）；heapdump。

**3. 怀疑做不到、没验证**（M7 里先查再说，查完回填这里）：Codex 的 mcp / apps / plugins / memories 有没有 app-server 接口；Claude 的 mcp / agents / memory 能否不经 TUI 增改；Claude 写 `settings.json` 能否换掉运行中会话的模型。

---

### 调研结论（2026-10，子 agent 实测，改代码前以此为准）

**Claude Code 2.1.289 的模型和强度（M7-b）**
- settings.json 键：`model`（别名 `default/opus/sonnet/haiku/fable` 或完整 ID）、`effortLevel`（`low/medium/high/xhigh`，不接受 `max`）、`modelSettings.<模型>.effortLevel`、`alwaysThinkingEnabled`、`fastMode`。Opus 5.5 的顶层 `effortLevel` 不生效，要写 `modelSettings`。
- **运行中的会话不会因为改 settings.json 换模型（实测）**，只在下次启动生效。`--resume` 时会话里明确选过模型的，会恢复那个，不理 settings；要可靠换要带 `--model X --effort Y`。
- 往 TUI 发 `/model <名>`、`/effort <值>` 可以带参数一次完成，下一条请求立即生效（实测）。副作用：会写用户全局 settings.json；缓存热时可能弹“Switch model?”确认框（Sonnet 5 上弹、Opus 5.5 上不弹，规律不明），按 `1` 确认；`/model bogus` **不校验**，会把默认模型写坏，GUI 必须自己校验。
- 当前实际模型和强度能从会话 jsonl 读：assistant 记录有 `message.model`、顶层 `effort`。
- **决定：走“往 TUI 发命令”（路线 B）**，同构于终端；GUI 校验名字；确认框出现就切到 TUI 视图；用 `message.model`/`effort` 确认已生效；新会话启动时顺带 `--model/--effort`。fast 没法在假服务下验证，**先只做模型和强度**。

**Codex 0.160.1（app-server，Filo 已带 `experimentalApi:true`）**
- `thread/compact/start` 只有 `threadId`，**不能带“保留什么”**。
- 用量：`thread/tokenUsage/updated`（Filo 已在收）+ `account/usage/read {threadId}`（需登录，未测）+ `account/rateLimits/read`。`/status` 没有单一方法，要拼 `thread/read`、`config/read`、tokenUsage、rateLimits。
- MCP：`mcpServerStatus/list` 读（实测）；启停用 `config/value/write mcp_servers.<名>.enabled` + `config/mcpServer/reload`（实测）。apps / plugins / memories 都有方法（`memory/status` 等）；`personality` 已弃用，不做。
- 另有：`thread/goal/*`、`review/start`、`collaborationMode/list`、`thread/shellCommand`。

**Grok（机器上是 1.0.62，不是之前写的 1.0.50；`shared/agents.ts` 固定 1.0.46）**
- 之前探测没应答是**我用错了入口**：`grok acp` 不是子命令（被当成 prompt 起了 TUI）。正确入口是 `grok --no-auto-update agent --no-leader stdio`，握手实测正常。
- 真实的 `available_commands_update` 仍没拿到（`session/new` 要登录态，没动用户凭据）。下面的名单来自二进制字符串，**未验证是否都会上报**：`compact always-approve flush dream memory context hooks-trust hooks-list hooks-add hooks-remove hooks-untrust plugins reload-plugins session-info feedback deep-research workflow goal loop`，另有用户技能。官方文档里的 TUI 命令全集更长（new/clear、resume、fork、rewind/undo、copy、export、rename、model、effort、plan、memory、mcps、usage/cost、settings 等），做 GUI 时按这个逐条对照。想要真实命令表，可以让 Filo 的 Grok 线程在运行时把它落日志。
- `_x.ai/compact_conversation` 只有 `sessionId`，**不能带“保留什么”**；压缩策略是配置（`features.compaction_mode`、`features.compaction_detail`、`[session] auto_compact_threshold_percent` 默认 85）。
- 用量：`grok usage <sessionId>` 是本地 CLI，输出 JSON（没跑过）；`grok mcp list/enable/disable/add/remove/doctor` 是 CLI（没试）。

**对计划的影响**
- M2-B 压缩弹层的“保留什么”：**只有 pi 和 Claude Code 显示**；Codex、Grok 不显示这一行（不假装支持）。
- M7-a：Codex 用量可做；Grok 用量先看 `grok usage`；Claude 的 `/usage` 仍做不了（M“GUI 做不到的”第 1 条）。
- M7-c：Codex 的 mcp 可做（有实测方法）；Grok 的 mcp 走 CLI。
- `electron` 里 Grok 的 `acp` 探测脚本别再用 `grok acp`。

---

### M1. 去掉 `/` 里对 TUI 的兼容层（GUI 就是 GUI）

**背景**
Filo 是 pi 的第二张脸，不是 TUI 的复刻。pi 的“编辑器命令”（`/compact`、`/name`、`/model`…）只在 pi 的交互模式里有，RPC 不认，所以 Filo 为了让用户在输入框里也能敲这些，写了一层兼容：
- `src/features/Composer/index.tsx`：`PI_BUILTINS`（pi 的 24 个内置命令名）、`APP_COMMANDS`（GUI 自己实现的几个：`new`、`resume`、`diff`、`model`、`settings`、`login`、`logout`、`copy`、`export`）、`SHARED_APP_COMMANDS`、`submit` 里“只在终端的 pi 可用 / 没有 /xxx 命令”的拦截提示。
- `packages/capabilities/extensions/builtins.ts`：用扩展 API 重做的 `compact`、`name`、`model`、`thinking`、`tree`、`fork`、`clone`、`reload`（另有 `gui-rewind`，是 GUI 自己用的，不是兼容层）。
用户的决定（2026-10，原话大意）：补完 GUI 入口以后，把 `/` 里这些能力去掉，因为产品是 GUI，保留就得一个个兼容。

**不删的是什么（按总方向改写）**
- 技能、提示模板、扩展命令、agent 自己的命令**在协议层仍是 `/xxx` 文字**，这一层不动；变的是用户界面：输入框里敲 `/` 的菜单换成 M2-C 的选择器。
- 内部命令 `gui-*`（`gui-rewind` 等），GUI 通过 `thread.guiCommand` 调，不是用户界面。
- 终端里的 pi 不受影响：`builtins.ts` 只在 Filo 的 pi 上加载（`electron/capabilities.ts`）。

**要做的（顺序不能反：先补 M2，再删）**
1. 完成 M2、M3 的 GUI 入口。
2. 删 `APP_COMMANDS`、`SHARED_APP_COMMANDS`、`PI_BUILTINS` 和 `submit` 里的拦截。整个斜杠菜单（`SlashMenu`、`slashMatches`、`slashQuery` 和键盘处理）删掉，换成 M2-C 的选择器。
3. `builtins.ts` 只留 `gui-rewind` 和它用到的 `navigate`、`busy` 等辅助；`compact`、`name`、`model`、`thinking`、`tree`、`fork`、`clone`、`reload` 删掉。
4. 输入 `/compact` 之类被删的命令，就是普通文字发给模型。**不要再加“该命令已移除”的提示拦截**，那又是一层兼容。
5. 改 `AGENTS.md`：“斜杠命令”一条（“现在已经同构的部分”里）改写成：Filo 不模拟 pi 的编辑器命令，对应能力在界面里；“例外”里加一条说明这点。把 `/diff`、`/model` 打开面板这类 ACP 用的也一并删（见下面“影响”）。
6. 删测试：`test/commands-e2e.ts` 里断言这些命令的部分、`packages/capabilities` 里对应单测；保留 agent 自己命令（Grok、Claude 的输出显示、未知命令）的测试。

**影响，别漏**
- 其他 agent 的部分单独写在 M1-B，和这一项一起做、一起验收。
- “Claude Code 未知命令也显示”“Grok 无输出命令的提示”“压缩进度”等是**显示 agent 自己命令的结果**，不是兼容层，保留。
- `e2e:commands` 的截图脚本要重排编号。

**验收**
- 输入框里敲 `/` 不再弹菜单；原来在菜单里的一切（内置命令、技能、模板、扩展、agent 自己的命令）都能在 GUI 里找到（内置命令是各自的按钮，其余在选择器里）。
- 每个被删命令对应的 GUI 入口都有，且 e2e 点过。
- `bun run typecheck`、`bun run test`、`bun run e2e:commands`、`e2e:acp`、`e2e:codex`、`e2e:claude-tui` 通过。
- 终端里的 pi（pi-cc-tui）不受影响，`test/terminal-e2e.ts` 不变。

**否掉的做法**
- 保留命令，只把拦截提示改好看：用户明确不要，维护成本还在。
- 删命令后提示“请用界面”：同上。

---

### M1-B. 其他 agent（Claude Code、Codex、Grok、OpenCode、Cursor、Gemini、Copilot）的 `/` 怎么处理

**原则：和 pi 完全一样，也服从总方向：输入框里没有斜杠菜单，每个 agent 的每个命令都要有 GUI 对应物。**
不分是 Filo 叠加的，还是 agent 自己报告的。Codex/Grok 的 `/compact`、Claude Code 的 `/model`、OpenCode 的 `/new`：有按钮的删命令；没按钮的（`/cost` `/context` `/init`…）先做 GUI。agent 报告的、没法预先画按钮的开放集合（OpenCode 的 20 个技能、用户自己的 `~/.claude/commands`），进 M2-C 的选择器。

**现状（2026-10，读代码和 e2e；除标注外都是实测）**

| agent | 菜单现在有什么 | 来源 |
|---|---|---|
| Claude Code | 只有 `compact` | `electron/native/claudeTui.ts` 的 `get_commands` 写死 |
| Codex | `compact`，加 Filo 叠加的 `new` `resume` `diff` `model` | `electron/native/codex.ts` 写死 + `SHARED_APP_COMMANDS` |
| OpenCode（1.18.34 实测上报） | `init`、`review`，以及 20 个技能（`agent-gui`、`cloudflare`、`wrangler`…）；加 Filo 叠加的 `new` `resume` `diff` `model` | ACP `available_commands_update` |
| Grok（1.0.50） | `compact`、`context`（e2e 的假 Grok 这样报；真 Grok 我这次没探到，需要登录状态，**未实测完整列表**）；加 Filo 叠加的四个 | 同上 |
| Cursor、Gemini、Copilot | 没装，**未验证** | ACP 通用路径 |

**逐个命令怎么分（有 GUI 的删命令；没有的先做 GUI；开放集合进选择器）**

| 命令（所属 agent） | GUI 里的对应 | 处理 |
|---|---|---|
| `compact`（Claude Code、Codex、Grok） | 压缩按钮（见 M2-B） | 做完 M2-B 后从菜单去掉 |
| `new`、`resume`、`diff`、`model`（Filo 对 Codex/ACP 叠加的） | 加号、⌘K、改动面板按钮、模型选择器 | 删掉叠加（M1 步骤 2） |
| `model`（Claude Code 自己的） | 模型选择器（渠道除外，Claude Code 写 `settings.json`，见 `AGENTS.md`） | 去掉 |
| `rename`（Claude Code、Grok） | 标签右键“重命名” | 去掉 |
| `clear`、`exit`、`quit`（Claude Code） | 新线程、关标签 | 去掉 |
| `login`、`logout`、`config`、`settings`（各家） | 设置页 | 去掉 |
| `cost`/`usage`、`context`（Claude Code、Grok） | 状态栏只有总数，没有明细 | 做成 GUI：点上下文数字弹出“用量明细”弹层，打开时由 Filo 向 agent 要数据（Claude Code 的 `/context` 输出写在会话文件里，已能读；Grok 的 `/context` 同理）。**不解析表格，原文显示**；做完删命令 |
| `init`、`review`（OpenCode；Codex 同名） | 没有（Filo 的 review 会另起一个 agent，语义不同，不算对应物） | `init`：做成项目里的按钮“让 agent 生成项目说明”（底层发 `/init`）；`review`：Filo 已有自己的 review，不映射，也不进选择器，避免两个同名入口 |
| 技能、提示模板（OpenCode 的 20 个技能等） | 没有预先画好的按钮 | 进 M2-C 选择器 |
| `status`、`mcp`、`permissions`、`memory` 等（Claude Code、Codex 自己的） | 状态栏有部分；其余没有 | 有对应的去；没有的先做 GUI；**具体名单要先拿到各家真实命令表**（见下面步骤 3），不凭记忆写 |

**要做的**
1. 删 `SHARED_APP_COMMANDS` 和 `appCommands` 对其他 agent 的叠加（M1 步骤 2 已包含）。
2. 选择器（M2-C）读 agent 报告的命令时，过滤掉名字在“GUI 已有”清单里的（`compact`、`model`、`new`…），免得选择器里和按钮重复。清单是**一个常量**，放 `src/lib/` 下，每条写“对应 GUI 的什么”，不散落在各 agent 的代码里；pi 的 `PI_BUILTINS` 合并进同一份。
3. **拿到真实命令表再定清单**：
   - ACP 的（Grok、OpenCode、Copilot、Cursor、Gemini）：起 agent、等 `available_commands_update`，Grok 要在登录后的真实会话里探。把各家完整列表贴进这份文档，逐条标“GUI 有 / 没有”。
   - Claude Code：现在写死只给 `compact`，用户不知道有 `/cost` `/context`。先查能不能从它拿到命令表（`claude -p --output-format stream-json` 的 init 事件带 `slash_commands`，**没试过，会启动一次 claude，先确认不会调用模型**）。拿得到就列出来再过滤；拿不到就不列，不手写清单。
   - Codex：app-server 没有命令表，菜单就是空的（不再写死 `compact`）。
4. **输入框里直接敲被去掉的命令**：不拦截、不提示，原样交给 agent（同 M1 步骤 4）。agent 自己认的会执行，不认的当文字。结果由 Filo 画出来，这点保留。
5. **保留，不是兼容层**（它们画的是 agent 命令的结果和状态，不是命令入口）：“已执行，没有输出”note、Grok 压缩进度行、Claude Code `/compact` 进度（`4d0216c`）、Claude 本地命令输出和 `Unknown command` 显示、`/cost` 之后先发 Esc、忽略焦点上报。
6. 测试：`test/commands-e2e.ts` 里这些断言要改：菜单里**没有** `new/resume/diff/model/compact`，**有** `context`、技能；Codex 菜单为空时 `/` 不弹菜单；敲 `/status` 时 agent 收到原文（假 agent 记录）。截图重排。

**验收**
- 各 agent 的选择器里，GUI 已有功能的命令一个都没有；agent 的技能和自定义命令都在。
- 过滤清单只有一处定义，每条有“对应 GUI”的说明。
- `bun run typecheck`、`bun run test`、`e2e:commands|acp|codex|claude-tui` 通过。

**否掉的做法**
- 手写 Codex 的 `/status` `/review` `/init` `/mcp` 映射、手写 Claude Code 命令清单：升版本就对不上，又是兼容层。
- 只改文案、不去掉：用户明确不要。

**要你定的（也列在 M5）**：Grok 的 `/compact` 如果用户直接敲，agent 不发“开始压缩”事件，GUI 没有进度行（这就是当初“Grok 压缩没 UI”那件事的原因，现在靠“敲 `/compact` 时改走 `thread.compact()`”解决）。按原则这层路由也该删，代价是敲命令压缩时没有进度，点按钮才有。我的建议：路由保留，因为它不是菜单入口，只是让文字敲出来的 `/compact` 不至于没反馈；但这跟“GUI 有就不支持 `/`”不完全一致，所以要你拍板。

---

### M2. 补 GUI 入口：只有斜杠命令才能做的事

**进度**：导出 HTML、会话信息、重新加载（都在标签右键菜单，`5f181b3`）、快捷键页（`9e8c16b`，`src/lib/shortcuts.ts` 单一常量，`App.tsx` 的按键处理从它读）、项目信任页（`88327f2`）已做，`e2e:gui-entries` 覆盖，截图 `30-gui-*`。**注意**：`/export`、`/reload` 的斜杠入口还在（删除统一在 M1）。`e2e:gui-entries` 不在 `bun run test` 里，要手动跑。

先弄清现状。逐个对过（2026-10，读代码，没在运行的 Filo 里逐个点）：

| 命令 | 现状 | 要做的 |
|---|---|---|
| `/export` | 只有斜杠入口：`request({type:'export_html'})` 后 `window.pi.revealPath(path)` | 放进标签右键菜单（`src/features/Tabs/ThreadActions.tsx`），文案“导出为 HTML”，成功后 toast，失败也要 toast |
| `/hotkeys` | 快捷键散在 `src/App.tsx` 的 `useShortcuts` 和 `src/platform.ts`，没有列表 | 做一个“快捷键”面板（设置里加一页，或 ⌘/ 弹出）。数据来源必须是**同一份常量**，不要手抄一份文案，否则改键就对不上 |
| `/session` | 状态栏只有上下文、花费、速率、改动行数 | 在状态栏的悬浮提示或线程菜单里给出：会话文件路径（可点开）、会话 id、消息数、各类 token 和花费。pi 用 `get_session_stats`，其他 agent 已有对应实现（`electron/native/*`、`electron/acp/agent.ts`） |
| `/trust` | 线程启动前会问，但事后无法改 | 设置里按项目显示信任状态，可改。读写用 pi 自己的 `ProjectTrustStore`（`trust.json`），不要另存 |
| `/reload` | 配置变了空闲线程自动重启，没有手动按钮 | 线程菜单加“重新加载扩展和技能”，对应 pi 的 `ctx.reload()`，通过 `gui-` 前缀的内部命令调用（保留在 `builtins.ts`） |
| `/quit` | 关标签、关窗口已有 | 什么都不用做 |
| `/name` | 标签右键“重命名”已有（`set_session_name`） | 不用做 |
| `/copy` | 每条回答上有复制按钮 | 不用做 |
| `/new` `/resume` `/settings` `/login` `/logout` | 加号、⌘K 搜索、设置页 | 不用做 |
| `/compact` | 状态栏上下文数字（藏着）、标签菜单“压缩上下文” | 做 M2-B：看得见的按钮，弹层里带可选的“保留什么”（现在 GUI 的压缩只发 `{type:'compact'}`，不带说明） |
| `/model` `/thinking` | 输入框里的选择器 | 不用做 |

**验收**：每个“要做”的入口有一条 e2e 断言（点它，看到效果），并截图进 `~/Documents/filo-command-shots/`。

---

### M2-B. 压缩做成一个看得见的按钮（所有 agent 通用）

**进度（`90ba40b`）**：按钮和弹层已做（输入框旁，`Pickers.tsx` 的 `CompactButton`；pi 和 Claude Code 带“保留什么”，Codex、Grok 不带，由 `features.compactInstructions` 决定）。e2e 覆盖 Grok 和 Claude Code，截图 `06a`、`25`。顺带修了一个 bug：Claude Code 的 `/compact` 没东西可压时，“Compacting context…”一直不结束。**未做**：pi 和 Codex 的 e2e 点按钮（`e2e:codex` 还没点过）；删各 agent 的 `compact` 菜单项和 `/compact` 路由（步骤 7，随 M1 一起做）。

**背景**
现在压缩的入口是藏着的：状态栏上下文数字“点击压缩”（`src/features/Thread/StatusLine.tsx`，提示文字里还写着 `/compact`），和标签右键菜单的“压缩上下文”（`ThreadActions.tsx`）。没人会想到去点一个数字，所以用户习惯敲 `/compact`，我们才一路给各 agent 做了 `/compact` 的兼容和路由（`submit` 里改走 `thread.compact()`、菜单里的 `compact` 项）。用户的判断：做成按钮，`/compact` 就不用支持了。

**要做的**
1. 在输入框附近放一个明确的“压缩上下文”按钮（图标加文字，不要只有数字）。位置跟上下文用量放在一起，用量高时可以提示色，但**不自动压缩**（自动压缩是 pi 设置里已有的事，见设置 → 压缩）。
2. 点开是一个小弹层：一行可选输入“要保留什么”，一个“压缩”按钮。留空就是直接压。这样 `/compact 保留xxx` 能力也有了，M5 第 1 条随之解决。
3. 各 agent 是否支持“保留什么”要分别查，不支持的就不显示那一行，**不要假装支持**：
   - pi：支持（`ctx.compact({ customInstructions })`）。
   - Claude Code：`/compact <说明>` 由 TUI 自己处理，应支持，用 e2e 确认。
   - Codex：`thread/compact/start` 看起来没有说明参数，**未核实**，先查协议再定。
   - Grok（`_x.ai/compact_conversation`）、其他 ACP：**未核实**。
4. 压缩期间沿用已有的“Compacting context…”行和 `compaction_start/end`，按钮置灰并显示“压缩中”；agent 正在跑时按钮禁用（已有逻辑：排队，见 `compactionQueue`）。
5. 不支持压缩的 agent（`features.compaction` 为 false）不显示按钮。
6. 标签右键菜单里的“压缩上下文”保留（它是同一个动作的第二个入口，不是 `/` 兼容）；状态栏数字的 title 去掉 `/compact` 字样。
7. 做完以后：菜单里去掉各 agent 的 `compact` 项，删 `submit` 里 `/compact` 改走 `thread.compact()` 的路由（M1-B、M5 第 5 条）。

**验收**
- e2e：点按钮压缩，出现 working 行，结束后出现摘要 note，上下文数字变小；带“保留什么”的版本，agent 收到的原文里有这句说明（用假 agent 记录）。
- 对 pi、Claude Code、Grok、Codex 各过一遍。
- 截图进 `~/Documents/filo-command-shots/`，并补一张按钮和弹层的。

**否掉的做法**
- 保留 `/compact` 作为“快捷方式”：用户明确不要，且每个 agent 都要单独兼容。
- 压缩阈值到了自动弹窗问用户：打断工作流，且 pi 已有自动压缩设置。

---

### M2-C. “技能与命令”选择器（取代斜杠菜单）

**背景**
技能、提示模板、扩展命令、agent 自己定义的命令是开放集合，不能每个画按钮。但“输入框里敲 `/` 弹菜单”是 TUI 的做法。GUI 的做法是一个明确的按钮加可搜索列表。

**要做的**
1. 输入框工具栏加一个按钮（图标加“技能”二字，不要只放图标），点开是可搜索列表，分组：技能、提示模板、扩展、agent 命令。数据来源还是 `thread.commands`（已有，各 agent 的实现不用改）。
2. 选中后不在输入框里写 `/xxx` 字样，而是插入一个**标签**（chip），后面可继续输入参数。发送时拼成 `/xxx 参数` 文字发给 agent，和 TUI 里同一份。键盘：⌘K 已被搜索占用，选一个未占用的快捷键，放进 `/hotkeys` 的面板（M2）。
3. 输入框里手敲 `/` 不再有任何特殊行为（M1 步骤 2、4）。
4. 同名冲突、过滤清单见 M1-B 步骤 2。
5. 已有 GUI 的扩展命令（`autopilot` 在 `Pickers.tsx`、`review`/`review-apply` 在 `ReviewStep.tsx`）不进选择器；`inbox` 我没找到对应 GUI，**需要先弄清它是什么、要不要 GUI**。
6. 文案走 `tr()`；列表项显示来源和一行描述；空状态写“还没有技能，到设置 → 技能里添加”。

**验收**
- e2e：点按钮，搜索，选一个技能，输入框里出现标签，发送后假 agent 收到的原文是 `/skill:xxx 参数`（与终端一致）。
- 各 agent（pi、Claude Code、Codex、OpenCode、Grok）的列表分别是它们自己报告的；Codex 没有命令表时按钮不显示，不显示空列表。
- 键盘能完整操作（方向键、回车、Esc），标签能用退格删除。
- 截图进 `~/Documents/filo-command-shots/`。

**否掉的做法**
- 给技能每个画一个按钮：技能是用户自己增加的，做不到。
- 保留 `/` 菜单只是换个皮：用户要的是 GUI，不是 TUI 换皮。

---

### M3. `/tree` 和 `/clone`：GUI 只覆盖了一部分

**进度**：克隆线程（标签菜单）和“回到这里”（回答上，带“总结离开的这一支”开关）已做，`e2e:gui-entries` 覆盖，红绿已确认，截图 `31-gui-*`。`/clone`、`/tree` 的斜杠入口还在（M1 删）。**未做**：树视图（按本节原计划不做）。

**背景**
- `/clone`：在当前位置复制出一个新会话。GUI 里“分叉线程”（标签菜单）是从某条提问分叉，不是“就在这里复制”。
- `/tree`：可以回到会话里任意一处，并选择是否总结离开的那一支。GUI 里每条提问上有“从这里分叉”和“再问一次”（回到提问之前，用 `gui-rewind`），但**不能选回答、不能总结被丢弃的分支**。

**要做的**（用户尚未拍板范围，先做最小的一档，剩下的放 M5）
1. “克隆线程”：标签菜单加一项，调 `fork(leaf, { position: 'at' })`，行为与 `/clone` 一样，新开标签。
2. `/tree` 的 GUI：先不做树视图。先在回答上也放“回到这里”，把“总结离开的分支”做成可选项（确认框里的开关，默认不总结）。

**验收**：克隆后新标签的消息与原线程当前分支一致；回到回答后继续提问，旧分支仍在会话文件里（`/tree` 在终端里能看到）。

---

### M4. 把之前说的、但不是 `/` 的 GUI 缺口理清

不在 M1 的删除范围，只是排查中发现 GUI 没有的功能，需要用户定要不要：
- `/scoped-models`：决定模型选择器里列出哪些模型（`settings.json` 的 `enabledModels`）。现在只有选默认模型时被动补一条（`electron/piSettings.ts`）。建议做成“设置 → 模型”里的勾选列表。
- `/import`：导入会话文件。
- `/share`：分享会话（pi 的分享是上传到第三方，需要用户明确同意才能做，涉及隐私，**不要默认实现**）。
- `/changelog`：看 pi 的更新日志。
- `/bug`：提交问题。
这几个都是 pi 内置命令。M1 之后它们在 Filo 的输入框里不会再被拦截提示，所以如果用户想要，要在这里补。

**核实结果（2026-10，读 pi 1.0.4 文档和源码，没实际运行）**：GUI 里这 5 个都没有入口。
- `/scoped-models`：写全局 `settings.json` 的 `enabledModels`。RPC 的 `get_available_models` 不按它过滤，只有 `cycle_model`、启动选模型、终端 Ctrl+P 用它。GUI 没有循环切换，所以对 GUI 只剩“常用模型”的意思；与终端同构的做法是读写同一个键。
- `/import`：导入会话 JSONL（不是 HTML），复制进会话目录再切过去。RPC 没有 import，只有 `switch_session`，要自己复刻目录和重名规则（编码规则未核实）。
- `/changelog`：读 pi 包目录的 `CHANGELOG.md`，不联网。RPC 没有，要自己定位包目录。
- `/bug`：一串对话框，上传到 `https://radius.pi.dev/v1/bug-reports`，会外发 pi 版本、系统、模型和供应商配置（去 key）、全局和项目 settings、崩溃日志，选“带会话”还会发完整 JSONL；选“摘要”会多花一次模型请求。没有 RPC，要碰内部函数。
- `/share`：上传到 Radius（需账号）或 `gh gist`（“不公开”但知道链接的人能看）。会话全文外发。没有 RPC。
- `/bug`、`/share` 外发数据又没有公开接口，和“不碰非公开后端”冲突，默认不做。

---

### M5. 需要用户拍板的事（做之前先问）

1. （已定，M2-B）压缩弹层带“保留什么”输入；各 agent 支不支持待查，不支持的不显示。
2. `/tree` 做到哪一档（M3）。
3. M4 里的 5 个，要哪些。
4. 在 Codex 里手敲 `/status`、OpenCode 里敲 `/undo` 之类，现在是 toast 拦截；总方向下改成原样发给 agent。代价：Codex 这类没有命令表的 agent，会把它当普通文字发给模型，白花一轮。这是总方向的直接后果，我的默认是接受，如果不想接受，要给它们各做 GUI（`status` 状态栏已有，`mcp` 等需要看 Codex 实际有什么）。
5. （已定，M2-B）`/compact` 的菜单项和改走 `thread.compact()` 的路由，随压缩按钮一起删。
6. `inbox` 扩展命令没有 GUI 对应物，要先弄清它是什么（M2-C 步骤 5）。
7. “技能与命令”选择器的按钮位置、快捷键（M2-C）。
8. M7-b：Claude Code 的模型、思考强度选择器，值不值得做，以及走写 `settings.json` 还是走 TUI 按键（我倾向前者）。
9. M7-c：mcp / agents / memory 等，先让我逐个核实用途再决定做不做。

（已定，不用再问：“没有输出”提示、压缩 working 行、Claude Code 命令输出显示，保留。）

---

### M7. 其他 agent 里缺的 GUI（对照总表里标“没有”的）

**M7-a 用量明细（Claude Code / Grok / Codex 的 `/context` `/usage` `/status`）**
- 背景：状态栏只有总数。Claude Code 的 `/context` 输出写在会话文件里（已能读）；`/usage` 是 TUI 屏幕画的，会话文件里没有（见本轮 `screenOnly` 的处理）。Grok 的 `/context` 同理待验证；Codex 的 `/status` 没验证。
- 要做的：点上下文数字弹“用量明细”。数据怎么取要**先逐个 agent 验证**能不能不靠敲命令拿到；拿不到的就在弹层里触发命令并显示原文，**不解析表格**。
- 验收：每个 agent 一条 e2e + 截图。
- **已做**：状态行的上下文数字点开就是「会话信息」弹层（token、缓存、花费、上下文，各 agent 同一份，`StatusLine.tsx`）。原来点它是压缩，压缩只留输入框旁的「压缩」按钮。`/usage` 屏幕里的明细仍拿不到（不读屏幕）。e2e：`commands-e2e.ts` 的 Grok 段。

**M7-b Claude Code 的模型、思考强度、fast 选择器**
- 背景：Claude 线程是它自己 TUI 的投影（`electron/native/claudeTui.ts`），`get_available_models`、`get_available_thinking_levels` 都返回空，`AGENTS.md` 明写“不支持选模型（渠道除外）”。所以 `/model`、`/effort`、`/fast` 现在没有任何 GUI 替代，只能切到终端视图敲。
- 要做的：先调研两条路——写 Claude 自己的 `settings.json`（`model`、`effortLevel` 之类，**键名要实测**，别凭记忆），或往 TUI 里发按键。倾向前者，因为不碰运行中的会话、不靠猜 TUI 的画面。做成输入框旁的选择器，改完需要重启线程时明说。
- 风险：写用户的 `settings.json` 要遵守 `AGENTS.md` 里“渠道”那条的写法（只在一处写、记原值、能换回）。不要冒充或绕开订阅规则。
- 验收：`e2e:claude-tui` 里选模型后，假 Anthropic 接口收到的 `model` 变了。
- **已做（路线 B：敲 `/model`、`/effort`）**：别名三个、强度 low/medium/high/xhigh；有历史时 GUI 先确认再替用户按 1；e2e 断言请求里的 `model` 和 `output_config.effort`。顺带修了一个重复显示：MessageDisplay 的 id 和会话记录的 id 对不上时，迟到的流式文字会把第一轮回答再画一遍（`claudeLog.ts` `replies`）。fast 没做（未实测）。

**M7-c 逐个核实后再定的**
Claude Code 的 `mcp`、`agents`、`memory`（改 CLAUDE.md）、`autocompact`，以及上面“我没核实用途”的那几项；Codex 的 `mcp`、`apps`、`plugins`、`memories`、`personality`、`experimental`。做法：先查每个命令实际干什么，再分三类——a) GUI 做个入口；b) 属于 TUI 外观，不做并写明理由；c) 用得很少，放到最后。**这一步结论出来前，不要给它们建 GUI。**

**M7-c 核实结果（2026-10，Claude Code 2.1.289、Codex 0.160.1）**，分类建议（用户未定）：

Claude Code
- 能做入口（A）：`mcp`（`claude mcp add|list|get|remove` 非交互；用户级写 `.claude.json` 顶层 `mcpServers`，项目级 `.mcp.json`；设了 `CLAUDE_CONFIG_DIR` 时文件在 `$CLAUDE_CONFIG_DIR/.claude.json`，已实测；reconnect/开关无子命令）；`fast`（settings 的 `fastMode`，运行中会话敲 `/fast on|off`，会话是否重读 settings 未核实）；`autocompact`（settings 的 `modelSettings.<模型>.autoCompactWindow`，旧版顶层 `autoCompactWindow`，运行中敲 `/autocompact`）；`goal`（会话内的完成条件，敲 `/goal <条件>`、`/goal clear`；状态在 JSONL 里的格式未核实）；`memory`（只做 `autoMemoryEnabled` 开关和打开 `CLAUDE.md`、`~/.claude/projects/<项目>/memory/`）。
- 不做（B）：`recap`（TUI 回来时的提示）、`auto-mode-setup`（一次性向导，最多只读 `claude auto-mode config`）。
- 很少用（C）：`insights`（花 token 生成 HTML 报告）、`team-onboarding`、`design-consent/revoke`（隐藏命令，服务端授权，需 claude.ai 登录）、`list-agents`（跨会话 inbox，Filo 已能显示子 agent；`/agents` 在此版本已移除）。

Codex（app-server 方法已用 `--experimental` 生成协议核对）
- 能做入口（A）：`mcp`（`mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`；增删用 `codex mcp add|remove` 或 `config/batchWrite` 写 `[mcp_servers.<name>]`）；`plugins`（`plugin/list|installed|install|uninstall`、`marketplace/*`）；`experimental`（`experimentalFeature/list`，开关写 `features.<name>`，重启线程生效）；`status`（`config/read`、`account/rateLimits/read`、`account/usage/read`，token 用量通知未核实；状态栏已有一部分）；`apps`（`app/list`，优先级中，API key 用户基本为空）；`memories`（`memory/status`、`memory/reset`、`thread/memoryMode/set`，默认关，低优先）。
- 不做：`personality`（协议里已标废弃）、`theme`、`title`（TUI 外观）。

---

### M6. 别的 AI 留下的未提交改动，需要有人收尾

- **已提交 `9a365fb`（红绿都验证过）；`test/installScripts.test.ts` 已提交 `40cd7a1`。** 下面是当时的说明：`src/features/Thread/MessageList.tsx` 和 `test/scroll-e2e.ts`：滚动改动。内容是“往下滚到离底部 4px 以内才重新吸附（`PIN_DISTANCE`），原来是 80px，会在用户刚往下滚一点时又把视图拉回底部”，e2e 里加了一段断言。这不是 `/` 相关工作的一部分，我没提交也没验证，需要作者或用户确认后单独提交（commit 只含这两个文件）。
- 未跟踪：`test/installScripts.test.ts`、`.claude/`、`build/icon-candidates/**`，同样不是这批工作的。
- 不要用 `git add .`。

---

### 通用规则（做这批事时）

- 回复用中文，简洁，结论先行。提交信息用英文。只在用户要求时才提交，按主题分提交。
- 修 bug 先写会红的测试，确认红了再修。构建失败时 dist 是旧的，会误判为绿，先确认构建通过。
- e2e 一律后台跑（`PI_GUI_BACKGROUND=1`），不抢焦点，跑完 `pkill -f pi-gui-commands`。不要杀用户自己的 Filo 进程。
- 文案走 `tr('中文', 'English')`。代码里不写正则堆砌的风格。不要用 `--no-verify`。
- 验证命令：`bun run typecheck`（不要 `--noEmit`）、`bun run test`、`bun run e2e:commands|acp|codex|claude-tui|queue|features|cli-sessions|routes`。

---

## 已完成

- **2026-10 斜杠命令审计与修复（各 agent）**：Grok 压缩 UI、Grok 配置里 `[model.filo-*]` 重复表导致启动失败的自愈、ACP 命令无输出提示、Claude Code 本地命令输出和未知命令显示、`/cost` 后 `/context` 被吞、`/diff` `/model` 映射、Grok 压缩中的 working 行、Claude Code `/compact` 的进度和顺序。提交：`1e3dffb` `3487238` `8035951` `1acb5cb` `83c6005` `e5a1681` `4c0f04d` `4d0216c`。
  - 这些里属于“兼容层”的（`/diff` `/model` 映射等）会在 M1 删除；属于“显示 agent 命令输出”的保留。
- **2026-10 M4 / M7-c 补 GUI 缺口**：pi 设置页（`/scoped-models`、`/changelog`，composer 模型选择器按常用模型过滤）`cddbd66`；导入会话 `/import` `801497e`；设置页「Claude Code」MCP（`claude mcp add|remove`）`10ac257`；压缩弹层里的自动压缩阈值（`/autocompact`）`47d5cbc`；Claude Code 记忆开关和文件 `657bce5`；设置页「Codex」MCP 与 beta 功能开关 `685f84a`。
  - 之后又做：pi 内置 MCP（设置 → Pi）、Grok MCP（设置 → Grok Build，`grok mcp`）、Codex 插件（安装/卸载/开关/插件源，`plugin/*` 与 `marketplace/*` 在本地插件源上实测）`76eeeff`、Claude Code `/goal` 的目标按钮（读 JSONL 的 `goal_status` 记录，实测）`d468328`、M2-B 压缩按钮在 pi 和 Codex 的 e2e 里改成点按钮、`/inbox` 记入 `GUI_HAS`（它是终端里跨会话的 Autopilot 卡片列表，Filo 里每个线程自己显示卡片，侧栏标出等待的线程；只在终端里开着、Filo 没开的会话的卡片看不到，没做）。
  - 再之后又做：Codex 应用和记忆（设置 → Codex，`app/list`、`memory/status`、`memory/reset` 在临时 CODEX_HOME 上实测，清空会真的删文件）、Claude `fast`（思考强度弹层里的开/关，发 `/fast on|off`，回复显示在线程里）、设置页提示条不盖对话框（含 560 高的最小窗口）、ESLint（`bun run lint`，只查错不查格式）、测试在三路并发下不再偶发失败（30s 超时、每个终端 pi 独占 tmux server、等整个菜单画完）。
  - 顺带修的真 bug：Claude Code 里不触发 hook 的本地斜杠命令（`/fast off`、`/goal clear`）结束后线程一直显示“运行中”（`claudeTui.ts` 的 `send` 现在等 1.5s，没有 turn 起来就当本地命令处理）。
  - 验证不到的：Codex 应用只能验证空列表和开关写配置（有应用要 ChatGPT 登录）；Claude `fast` 的“开”只验证了“组织已禁用”的回复，成功路径要有支持 fast 的套餐。
  - 没做：`/bug`、`/share` 会把用户数据传给第三方，不做；只在终端开着、Filo 没连的会话的 Autopilot 卡片在 Filo 里看不到。
  - 未验证：没有人手动用过这些新设置页（验证用的是临时配置目录和假接口）。
- 截图：`~/Documents/filo-command-shots/` 27 张（`bun run e2e:commands` 生成）。

### 1. 默认模型与模型记忆（已完成）
- 默认模型设为 Opus 5.5
- 记住用户上次选择的模型
- 每个 Agent 单独记住自己选用的模型

### 2. 去掉内置 pi 层，直接使用系统 pi（已完成）
- 安装时直接使用系统的 pi，不再有"内置层"（bundled-pi）这个概念
- 风险：用户系统 pi 里装的 pi-cc-tui 插件可能会破坏用户自己的 UI，需要评估或隔离

### 3. 修复虚拟滚动下的跳动（已完成）
- Agent 实时生成、逐字输出时，虚拟滚动列表仍有跳动
- bash 跑完后保留最后 5 行输出（对齐 pi TUI），不再收起

### 4. 代码文件树 + 万能 Tab（已完成）
- 文件树像 WebStorm 一样放在左侧，通过视图按钮切换，直接浏览
- Tab 做成万能 Tab：除了对话，也能打开代码编辑器

### 5. 缓存过期提示（已完成）
- 5 分钟缓存过期时提示用户
- 或者提供一个统一展示警告信息的地方
