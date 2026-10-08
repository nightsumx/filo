# pi-cc-tui

让 [pi](https://pi.dev) 长得和 Claude Code 一样。

```
❯ 你好，只回一个字

⏺ 好

✻ Worked for 3s · done 7:11 PM

────────────────────────────────────────────────────────────────────────────────
❯ █
────────────────────────────────────────────────────────────────────────────────
  my-app ██░░░ 410k/1000k $3.20 Opus 5.5 (high) ⏱ 12s
  ⏵⏵ bypass permissions on (option+m to cycle)                      55% until auto-compact
```

[English](./README.md)

## 安装

```bash
pi install npm:pi-cc-tui
```

如果还没设置过主题，会自动用暗色的 `claude-code` 主题。已经设置过的话，用 `/theme` 选 `claude-code`（或 `claude-code-light`），或者写进 `~/.pi/agent/settings.json`。写 `"claude-code-light/claude-code"` 会跟随终端的亮色 / 暗色：

```json
{ "theme": "claude-code" }
```

不安装、只试一次：`pi -e npm:pi-cc-tui`

## 改了什么

**启动界面**：Claude Code 的 `✻ Welcome to …` 边框，带当前目录，替换 pi 的 logo 和快捷键列表。

**输入框**：`❯ ` 提示符，折行缩进对齐，上下两条通栏灰线。鼠标点击位置照常准确。
- 输入 `!` 时提示符变成粉色 `!`（bash 模式）。
- 空输入框按 `?` 显示快捷键面板，按任意键关闭。
- `/` 命令菜单去掉箭头，选中项用淡紫色高亮。
- 粘贴的剪贴板图片显示为 `[Image #1]`。模型支持图片时按附件发送（和 Claude Code 一样），不再发临时文件路径。

**用户消息**：灰底块带暗色 `❯ `，去掉上下空行。

**回复正文**：`⏺ ` 开头，折行缩进 2 格。代码块不画 ``` 围栏，引用用暗色 `▎`，链接用 OSC 8 超链接。

**进度行**：`✻ Brewing… (12s · ↓ 1.2k tokens · thinking · esc to interrupt)` 放在输入框上方，不再嵌进边框，下面一行是 `⎿  Tip: …` 或 todo 列表；回合结束留一行 `✻ Brewed for 34s · done 7:09 PM`。有进行中的 todo 时，用它的 `activeForm`（"Running tests…"）代替随机动词。

**中断、报错和排队消息**：按 esc 中断后显示 `⎿  Interrupted by user`，不再是 `Operation aborted`；请求失败显示 `⎿  API Error: 529 …`。pi 自动重试时，进度行变成 `⎿  API Error (Overloaded) · Retrying in 3 seconds… (attempt 1/10)`。pi 工作时输入的消息显示成灰色 `❯ …`，不再是 `Steering: …`。

**`!` 命令**：`! cmd` 用用户消息的底色，输出挂在 `⎿` 下面，不再是带上下边框的 `$ cmd`。pi 的 20 行尾部预览、ctrl+o 展开、截断提示都保留。

**退出**：第一次按 ctrl+c，状态栏第二行显示 `Press ctrl+c again to exit`；800ms 内再按一次退出（pi 原本是 500ms，没有提示）。

**权限模式**：option+m（非 macOS 是 alt+m）切换 Claude Code 的几种模式；shift+tab 仍归 pi 切换思考强度。`/permissions` 直接选，`--gui-approval ask|edits|auto` 设启动时的审批模式（默认 `auto`）。

| 模式 | 改文件（`edit`、`write`） | 跑命令（`bash`、`powershell`） |
|---|---|---|
| `bypassPermissions`（默认，即 pi 原本的行为） | 直接执行 | 直接执行 |
| `default` | 询问 | 询问；只读命令（`ls`、`git status`、`rg` 等）直接执行 |
| `acceptEdits` | 项目内直接执行，项目外询问 | 同 `default` |
| `plan` | 只开放只读工具，直到你批准方案 | 只允许只读命令 |

询问框是 Claude Code 的圆角框：↑/↓ 加回车，或直接按 1–3；esc 等于 No。选项：Yes；"Yes, allow all edits during this session"（切到 `acceptEdits`）或 "don't ask again for … this session"；No，会结束本回合，同一批里剩下的工具调用也一并拒绝，等你说怎么做。print 和 JSON 模式从不询问。桌面版规则相同。

**Plan 模式**：模型用只读工具调研，然后调用 `propose_plan`。方案显示在 `Ready to code?` 框里：批准并自动接受修改、批准但继续逐个询问、或者写一句要改什么让它继续规划。

**提问**：`ask` 工具，一次一题显示在框里：按 1–9 或 ↑/↓ 选择，允许多选时空格切换，也可以选 "Type something" 自己填。回答以 `⏺ User answered pi's questions:` 留在对话里。

**Todo**：`todo` 工具（`text`、`status`，可选 `activeForm`），显示成 `⏺ Update Todos`，下面是 `☐` / 加粗 `☐` / 划线 `☒`。列表跟随会话分支。

**子代理**：`subagent` 工具在单独的 pi 里跑一个任务，显示成 Claude Code 的 Task：运行中列出最近的工具调用，结束后是 `⎿  Done (3 tool uses · 12.4k tokens · 41s)`；ctrl+o 展开它的回复。它的审批请求会弹到你的会话里，并标上它的名字。

**审查**：`/review [重点]` 在后台另起一个只读的 pi 审查本会话的改动。它拿到你的消息、diff 和 Agent 的说法（不含推理过程），自己跑命令去核实，问题分为「已复现」（附命令的退出码和输出）和「推测」。`/review-apply [R1 S2 …] [备注]` 把选中的条目交回给 Agent，不写编号就交回全部问题。

**自动驾驶**：`/autopilot` 开关。打开后每轮结束，另一个只读的 pi 按你的规则库（`~/.pi/agent/autopilot/rules.md`）检查结果，替你回复 Agent：继续、去验证、提交，或者结束。推送、部署、发布、付费生成、删除未提交的东西、sudo、打印密钥会被拦下，变成卡片。审美、方向、花钱这类只有你能定的事也会变成卡片。`/inbox` 处理所有会话里等你的卡片。你在它开着时插的话会记下来，`/autopilot learn` 据此提议改规则。

审批、Plan 模式、提问、Todo、子代理、审查和自动驾驶来自 `pi-capabilities`，和 Filo 桌面版用的是同一套扩展，打包在本插件里。在桌面版里这些会自动关闭，由桌面版自己加载。

**压缩进度**：`/compact` 和自动压缩时显示 `· Compacting conversation… (1m 37s · ↓ 2.1k tokens · esc to cancel)`，下面一行 `▰▰▰▱▱▱ 60%` 进度条。仍然走 pi 默认的摘要逻辑；摘要最终长度事先未知，进度按已流出的 token 估算，逐渐逼近 99%，不是精确完成度。

**状态栏**：两行。第一行是 Claude Code 常见 `statusLine` 脚本的精简版；第二行是 Claude Code 的模式行：左边是权限模式（`default` 下显示 `? for shortcuts`，输入命令时显示 `! for bash mode`），右边是距自动压缩的估算。

| 段 | 含义 | 颜色 |
|---|---|---|
| `my-app` | 当前目录 | 天蓝 |
| `██░░░ 410k/1000k` | 上下文占用 | 绿 → 50% 琥珀 → 80% 珊瑚红 |
| `$3.20` | 本会话花费 | 灰 → $1 琥珀 → $5 珊瑚红 |
| `Opus 5.5 (high)` | 模型；思考强度 high / xhigh / max 时显示 | 淡紫 / 琥珀 |
| `⏱ 12s` | 距上次回复 | 4 分钟琥珀，5 分钟变 `✗` 珊瑚红（提示缓存过期） |
| `55% until auto-compact` | 第二行右对齐，按 pi 的 `compaction.reserveTokens` 计算 | 灰 |

**主题 `claude-code` 和 `claude-code-light`**：Claude Code 的暗色和亮色配色。正文用终端默认前景色，行内代码和链接用和 Claude Code 相同的 256 色号（153 / 12），同一个终端里两边渲染完全一致。代码块用 16 色 ANSI 调色板，diff 用 Monokai，和 Claude Code 暗色一样。亮色主题用 Claude Code 亮色的配色。

## 配合 Filo 桌面版

pi-cc-tui 让 [Filo 桌面版](https://github.com/nightsumx/filo)看得见、也能连上终端里的 pi。不用桌面版的话，终端里什么都不变。

- **状态同步**：桌面版的项目树里会列出这个 pi，显示在跑、等你回答还是空闲，读的是 `~/.pi/agent/pi-kit-presence/<pid>.json` 这个小文件。
- **直连**：在桌面版打开同一个会话时，它会直接连上这个 pi，不再在同一个文件上另起一个（那样对话会分叉）。终端里打的字实时显示在桌面版，思考过程也有；桌面版发的消息、停止、切模型都在这里执行。审批、提问、计划确认两边都会弹出，哪边先回答，另一边的就关掉。连接走 unix socket `~/.pi/agent/pi-kit-presence/<pid>.sock`，只有你自己的用户能打开，上面跑的是 pi 的 RPC 协议。退出 pi（或 `/new`、`/resume`）后桌面版自动断开，对话内容保留。连接期间，分叉和清空排队消息只能在终端里做。

## 推荐搭配

工具调用和 diff 由 [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 画。它的底栏、进度文字、回合摘要和本插件重叠，在 `~/.pi/agent/pi-cc-extensions.json` 里关掉：

```json
{
  "enableCustomFooter": false,
  "enableWorkingMessage": false,
  "enableAgentSummary": false,
  "showStartupHeader": false,
  "excludeRenderers": ["todo", "ask", "propose_plan", "subagent"]
}
```

`showStartupHeader` 避免它的启动页和欢迎框抢位置。`excludeRenderers` 让这些工具自己画，否则 pi-cc-extensions 会把它们当普通工具调用显示。多个工具同时运行时，它仍会合并成一行 `Multiple Tools`。

pi 认不出的终端（比如 JetBrains）会把链接显示成 `文字 (url)`。在 `~/.pi/agent/settings.json` 里打开超链接：

```json
{ "terminal": { "hyperlinks": true } }
```

JetBrains 在全屏模式下也会自己打开被点击的链接，所以在 JetBrains 里 pi 不再重复打开，交给终端处理。

## 说明

- 输入框、消息、markdown、进度行的调整是在加载时给 pi 内置组件打补丁。pi 以后改了这些方法名，补丁只会失效，不会崩。
- 思考过程默认显示（点击或 ctrl+t 折叠成 `✻ Thinking…`），Claude Code 是隐藏的。想一致就在设置里加 `"hideThinkingBlock": true`。
- 压缩完成后的记录保持 pi 自己的样式，只改了进度行。
- 大段文本粘贴保留 pi 的 `[paste #1 +42 lines]`。Claude Code 的 `[Pasted text #1 …]` 更宽，而 pi 只把自己的标记当成一个整体来移动光标和删除。
- macOS 上 option+m 需要终端把 Option 当 Meta 发送（iTerm2：Profiles → Keys；JetBrains："Use Option as Meta key"），和 pi 自带的 option+enter、option+up 一样。

## 许可证

MIT
