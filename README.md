# pi-cc-tui

Make [pi](https://pi.dev) look like Claude Code.

```
❯ 你好，只回一个字

 好

────────────────────────────────────────────────────────────────────────────────
❯ █
────────────────────────────────────────────────────────────────────────────────
  ➜ my-app ██░░░ 41% 410k/1000k ⚡ 4.1ktok 69/s $3.20 +215 -3 Opus 5.5 (high) ⏱ 12s      55% until auto-compact
```

[简体中文](./README.zh-CN.md)

## Install

```bash
pi install npm:pi-cc-tui
```

Then pick the theme with `/theme` → `claude-code`, or set it in `~/.pi/agent/settings.json`:

```json
{ "theme": "claude-code" }
```

Try it once without installing: `pi -e npm:pi-cc-tui`

## What it changes

**Input box** — `❯ ` prompt, wrapped lines indented under it, full-width gray rules above and below. Mouse clicks still land on the right column.

**User messages** — the gray block hugs the text, no blank padding rows.

**Status line** — one line, same segments, glyphs and colors as a popular Claude Code `statusLine` script:

| Segment | Meaning | Color |
|---|---|---|
| `➜ my-app` | current directory | sage / sky blue |
| `██░░░ 41% 410k/1000k` | context used | green → amber at 50% → coral at 80% |
| `⚡ 4.1ktok 69/s` | output tokens in the last 60s | shown only while generating |
| `$3.20` | session cost | gray → amber at $1 → coral at $5 |
| `+215 -3` | lines written / edited this session | green / coral |
| `Opus 5.5 (high)` | model, thinking level when high / xhigh / max | lavender / amber |
| `⏱ 12s` | time since last reply | amber at 4 min, `✗` coral at 5 min (prompt cache expired) |
| `55% until auto-compact` | right-aligned, from pi's `compaction.reserveTokens` | gray |

**Theme `claude-code`** — Claude Code's dark palette. Body text uses the terminal's default foreground and inline code / links use the same 256-color indexes as Claude Code (153 / 12), so both apps render identically in the same terminal. Syntax highlighting is Monokai, like Claude Code dark.

## Pairs well with

[pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) renders tool calls, diffs and thinking in Claude Code style. Its own footer replaces this one, so turn it off in `~/.pi/agent/pi-cc-extensions.json`:

```json
{ "enableCustomFooter": false }
```

For Monokai diffs in pi-cc-extensions, add `export DIFF_THEME=monokai` to your shell profile.

## Notes

- The input box and user-message tweaks patch pi's built-in components at load time. A pi release that renames `Editor.render` or `UserMessageComponent.rebuild` would make them no-ops, not crash.
- Claude Code's second status row (`⏵⏵ bypass permissions on …`) has no pi equivalent and is not drawn.

## License

MIT
