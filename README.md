# pi-cc-tui

Make [pi](https://pi.dev) look like Claude Code.

```
❯ 你好，只回一个字

 ⏺ 好

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

The dark `claude-code` theme is applied automatically if you haven't set a theme yet. If you have, switch with `/theme` → `claude-code`, or set it in `~/.pi/agent/settings.json`:

```json
{ "theme": "claude-code" }
```

Try it once without installing: `pi -e npm:pi-cc-tui`

## What it changes

**Input box** — `❯ ` prompt, wrapped lines indented under it, full-width gray rules above and below. Mouse clicks still land on the right column.

**User messages** — gray block with a dim `❯ `, no blank padding rows.

**Assistant text** — `⏺ ` marker with a 2-column hanging indent. Code blocks without ``` fences, quotes with a dim `▎`, links as OSC 8 hyperlinks.

**Working line** — `✻ Brewing… (12s · ↓ 1.2k tokens)` above the input instead of inside its border, and `✻ Brewed for 34s · done 7:09 PM` when the turn ends.

**Compaction** — `· Compacting conversation… (1m 37s · ↓ 2.1k tokens · esc to cancel)` with a `▰▰▰▱▱▱ 60%` bar underneath, for both `/compact` and auto-compaction. pi's default summarizer still runs; the bar is an estimate from streamed summary tokens (the final length isn't known up front), so it eases toward 99% instead of tracking exact completion.

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

**Theme `claude-code`** — Claude Code's dark palette. Body text uses the terminal's default foreground and inline code / links use the same 256-color indexes as Claude Code (153 / 12), so both apps render identically in the same terminal. Code blocks use the 16-color ANSI palette and diffs use Monokai, like Claude Code dark.

## Pairs well with

[pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) draws tool calls and diffs. Its footer, working message and turn summary overlap with this package, so turn them off in `~/.pi/agent/pi-cc-extensions.json`:

```json
{ "enableCustomFooter": false, "enableWorkingMessage": false, "enableAgentSummary": false }
```

Terminals pi doesn't recognise (JetBrains, for one) get links as `text (url)`. Turn on hyperlinks in `~/.pi/agent/settings.json`:

```json
{ "terminal": { "hyperlinks": true } }
```

## Notes

- The input box, messages, markdown and spinner tweaks patch pi's built-in components at load time. A pi release that renames those methods would make them no-ops, not crash.
- Thinking stays visible (click or Shift+Tab to fold); Claude Code hides it. Set `"hideThinkingBlock": true` in settings to match.
- Claude Code's second status row (`⏵⏵ bypass permissions on …`) has no pi equivalent and is not drawn.

## License

MIT
