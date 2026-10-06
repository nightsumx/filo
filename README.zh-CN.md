# pi-cc-tui

让 [pi](https://pi.dev) 长得和 Claude Code 一样。

```
❯ 你好，只回一个字

⏺ 好

✻ Worked for 3s · done 7:11 PM

────────────────────────────────────────────────────────────────────────────────
❯ █
────────────────────────────────────────────────────────────────────────────────
  ➜ my-app ██░░░ 41% 410k/1000k ⚡ 4.1ktok 69/s $3.20 +215 -3 Opus 5.5 (high) ⏱ 12s      55% until auto-compact
```

[English](./README.md)

## 安装

```bash
pi install npm:pi-cc-tui
```

如果还没设置过主题，会自动用暗色的 `claude-code` 主题。已经设置过的话，用 `/theme` 选 `claude-code`，或者写进 `~/.pi/agent/settings.json`：

```json
{ "theme": "claude-code" }
```

不安装、只试一次：`pi -e npm:pi-cc-tui`

## 改了什么

**输入框**：`❯ ` 提示符，折行缩进对齐，上下两条通栏灰线。鼠标点击位置照常准确。

**用户消息**：灰底块带暗色 `❯ `，去掉上下空行。

**回复正文**：`⏺ ` 开头，折行缩进 2 格。代码块不画 ``` 围栏，引用用暗色 `▎`，链接用 OSC 8 超链接。

**进度行**：`✻ Brewing… (12s · ↓ 1.2k tokens)` 放在输入框上方，不再嵌进边框；回合结束留一行 `✻ Brewed for 34s · done 7:09 PM`。

**压缩进度**：`/compact` 和自动压缩时显示 `· Compacting conversation… (1m 37s · ↓ 2.1k tokens · esc to cancel)`，下面一行 `▰▰▰▱▱▱ 60%` 进度条。仍然走 pi 默认的摘要逻辑；摘要最终长度事先未知，进度按已流出的 token 估算，逐渐逼近 99%，不是精确完成度。

**状态栏**：一行，段落、符号、配色都和 Claude Code 常见的 `statusLine` 脚本一致：

| 段 | 含义 | 颜色 |
|---|---|---|
| `➜ my-app` | 当前目录 | 灰绿 / 天蓝 |
| `██░░░ 41% 410k/1000k` | 上下文占用 | 绿 → 50% 琥珀 → 80% 珊瑚红 |
| `⚡ 4.1ktok 69/s` | 最近 60 秒输出 token | 只在生成时出现 |
| `$3.20` | 本会话花费 | 灰 → $1 琥珀 → $5 珊瑚红 |
| `+215 -3` | 本会话写入 / 编辑的行数 | 绿 / 珊瑚红 |
| `Opus 5.5 (high)` | 模型；思考强度 high / xhigh / max 时显示 | 淡紫 / 琥珀 |
| `⏱ 12s` | 距上次回复 | 4 分钟琥珀，5 分钟变 `✗` 珊瑚红（提示缓存过期） |
| `55% until auto-compact` | 右对齐，按 pi 的 `compaction.reserveTokens` 计算 | 灰 |

**主题 `claude-code`**：Claude Code 暗色配色。正文用终端默认前景色，行内代码和链接用和 Claude Code 相同的 256 色号（153 / 12），同一个终端里两边渲染完全一致。代码块用 16 色 ANSI 调色板，diff 用 Monokai，和 Claude Code 暗色一样。

## 推荐搭配

工具调用和 diff 由 [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 画。它的底栏、进度文字、回合摘要和本插件重叠，在 `~/.pi/agent/pi-cc-extensions.json` 里关掉：

```json
{ "enableCustomFooter": false, "enableWorkingMessage": false, "enableAgentSummary": false }
```

pi 认不出的终端（比如 JetBrains）会把链接显示成 `文字 (url)`。在 `~/.pi/agent/settings.json` 里打开超链接：

```json
{ "terminal": { "hyperlinks": true } }
```

## 说明

- 输入框、消息、markdown、进度行的调整是在加载时给 pi 内置组件打补丁。pi 以后改了这些方法名，补丁只会失效，不会崩。
- 思考过程默认显示（点击或 Shift+Tab 折叠），Claude Code 是隐藏的。想一致就在设置里加 `"hideThinkingBlock": true`。
- Claude Code 状态栏的第二行（`⏵⏵ bypass permissions on …`）pi 没有对应概念，不画。

## 许可证

MIT
