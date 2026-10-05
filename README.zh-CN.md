# pi-cc-tui

让 [pi](https://pi.dev) 长得和 Claude Code 一样。

```
❯ 你好，只回一个字

 好

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

然后用 `/theme` 选 `claude-code`，或者写进 `~/.pi/agent/settings.json`：

```json
{ "theme": "claude-code" }
```

不安装、只试一次：`pi -e npm:pi-cc-tui`

## 改了什么

**输入框**：`❯ ` 提示符，折行缩进对齐，上下两条通栏灰线。鼠标点击位置照常准确。

**用户消息**：灰底块紧贴文字，去掉上下空行。

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

**主题 `claude-code`**：Claude Code 暗色配色。正文用终端默认前景色，行内代码和链接用和 Claude Code 相同的 256 色号（153 / 12），同一个终端里两边渲染完全一致。代码高亮是 Monokai，和 Claude Code 暗色一样。

## 推荐搭配

[pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 把工具调用、diff、思考过程渲染成 Claude Code 风格。它自带的底栏会盖掉本插件的状态栏，在 `~/.pi/agent/pi-cc-extensions.json` 里关掉：

```json
{ "enableCustomFooter": false }
```

想让 pi-cc-extensions 的 diff 也用 Monokai，在 shell 配置里加 `export DIFF_THEME=monokai`。

## 说明

- 输入框和用户消息的调整是在加载时给 pi 内置组件打补丁。如果 pi 以后改名了 `Editor.render` 或 `UserMessageComponent.rebuild`，补丁只会失效，不会崩。
- Claude Code 状态栏的第二行（`⏵⏵ bypass permissions on …`）pi 没有对应概念，不画。

## 许可证

MIT
