# pi-cc-tui

Make [pi](https://pi.dev) look like Claude Code.

```
❯ 你好，只回一个字

 ⏺ 好

────────────────────────────────────────────────────────────────────────────────
❯ █
────────────────────────────────────────────────────────────────────────────────
  ➜ my-app ██░░░ 41% 410k/1000k ⚡ 4.1ktok 69/s $3.20 +215 -3 Opus 5.5 (high) ⏱ 12s
  ⏵⏵ bypass permissions on (option+m to cycle)                      55% until auto-compact
```

[简体中文](./README.zh-CN.md)

## Install

```bash
pi install npm:pi-cc-tui
```

The dark `claude-code` theme is applied automatically if you haven't set a theme yet. If you have, switch with `/theme` → `claude-code` (or `claude-code-light`), or set it in `~/.pi/agent/settings.json`. `"claude-code-light/claude-code"` follows the terminal's light or dark appearance:

```json
{ "theme": "claude-code" }
```

Try it once without installing: `pi -e npm:pi-cc-tui`

## What it changes

**Startup** — Claude Code's `✻ Welcome to …` box with the cwd, instead of pi's logo and key list.

**Input box** — `❯ ` prompt, wrapped lines indented under it, full-width gray rules above and below. Mouse clicks still land on the right column.
- `!` switches the prompt to a pink `!` (bash mode).
- `?` on an empty prompt shows the shortcuts panel; any key closes it.
- The `/` menu has no arrow and highlights the selected command in lavender.
- Pasted clipboard images show as `[Image #1]`. If the model accepts images they are sent as attachments, like Claude Code, instead of as a temp-file path.

**User messages** — gray block with a dim `❯ `, no blank padding rows.

**Assistant text** — `⏺ ` marker with a 2-column hanging indent. Code blocks without ``` fences, quotes with a dim `▎`, links as OSC 8 hyperlinks.

**Working line** — `✻ Brewing… (12s · ↓ 1.2k tokens · thinking · esc to interrupt)` above the input instead of inside its border, with `⎿  Tip: …` or the todo list under it, and `✻ Brewed for 34s · done 7:09 PM` when the turn ends. While a todo is in progress, its `activeForm` ("Running tests…") replaces the random verb.

**Interrupts and queued messages** — esc leaves `⎿  Interrupted by user` instead of `Operation aborted`. Messages typed while pi works show as gray `❯ …` lines instead of `Steering: …`.

**Permission modes** — option+m (alt+m off macOS) cycles Claude Code's modes; pi keeps shift+tab for thinking levels. `/permissions` picks one, `--permission-mode <mode>` sets the starting mode.

| Mode | Edits (`edit`, `write`) | Commands (`bash`, `powershell`) |
|---|---|---|
| `bypassPermissions` (default, pi's behavior) | run | run |
| `default` | ask | ask |
| `acceptEdits` | run | ask |
| `plan` | blocked, and the model is told to plan first | ask |

The prompt offers Yes, "Yes, allow all edits during this session" (switches to `acceptEdits`) or "don't ask again for this command", and No, which stops the turn. Print and JSON modes never ask.

**Todos** — a `TodoWrite` tool with Claude Code's schema (`content`, `status`, `activeForm`), drawn as `☐` / bold `☐` / struck-through `☒`. The list follows the session branch. `/todos` prints it.

**Compaction** — `· Compacting conversation… (1m 37s · ↓ 2.1k tokens · esc to cancel)` with a `▰▰▰▱▱▱ 60%` bar underneath, for both `/compact` and auto-compaction. pi's default summarizer still runs; the bar is an estimate from streamed summary tokens (the final length isn't known up front), so it eases toward 99% instead of tracking exact completion.

**Status line** — two lines. The first has the same segments, glyphs and colors as a popular Claude Code `statusLine` script. The second is Claude Code's mode row: the permission mode (`? for shortcuts` in `default`, `! for bash mode` while typing a command) and the auto-compact estimate on the right.

| Segment | Meaning | Color |
|---|---|---|
| `➜ my-app` | current directory | sage / sky blue |
| `██░░░ 41% 410k/1000k` | context used | green → amber at 50% → coral at 80% |
| `⚡ 4.1ktok 69/s` | output tokens in the last 60s | shown only while generating |
| `$3.20` | session cost | gray → amber at $1 → coral at $5 |
| `+215 -3` | lines written / edited this session | green / coral |
| `Opus 5.5 (high)` | model, thinking level when high / xhigh / max | lavender / amber |
| `⏱ 12s` | time since last reply | amber at 4 min, `✗` coral at 5 min (prompt cache expired) |
| `55% until auto-compact` | second line, right-aligned, from pi's `compaction.reserveTokens` | gray |

**Themes `claude-code` and `claude-code-light`** — Claude Code's dark and light palettes. Body text uses the terminal's default foreground and inline code / links use the same 256-color indexes as Claude Code (153 / 12), so both apps render identically in the same terminal. Code blocks use the 16-color ANSI palette and diffs use Monokai, like Claude Code dark. The light theme uses Claude Code's light colors.

## Pairs well with

[pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) draws tool calls and diffs. Its footer, working message and turn summary overlap with this package, so turn them off in `~/.pi/agent/pi-cc-extensions.json`:

```json
{
  "enableCustomFooter": false,
  "enableWorkingMessage": false,
  "enableAgentSummary": false,
  "showStartupHeader": false,
  "excludeRenderers": ["TodoWrite"]
}
```

`showStartupHeader` keeps its header from competing with the welcome box. `excludeRenderers` lets `TodoWrite` draw its checkbox list; otherwise pi-cc-extensions shows it as a generic tool call.

Terminals pi doesn't recognise (JetBrains, for one) get links as `text (url)`. Turn on hyperlinks in `~/.pi/agent/settings.json`:

```json
{ "terminal": { "hyperlinks": true } }
```

## Notes

- The input box, messages, markdown and spinner tweaks patch pi's built-in components at load time. A pi release that renames those methods would make them no-ops, not crash.
- Thinking stays visible (click or ctrl+t to fold to `✻ Thinking…`); Claude Code hides it. Set `"hideThinkingBlock": true` in settings to match.
- Compaction keeps pi's own summary entry; only the progress line is restyled.
- Large text pastes keep pi's `[paste #1 +42 lines]` marker. Claude Code's `[Pasted text #1 …]` is wider, and pi treats only its own marker as one unit for cursor movement and deletion.
- On macOS, option+m needs the terminal to send Option as Meta (iTerm2: Profiles → Keys; JetBrains: "Use Option as Meta key"), the same as pi's own option+enter and option+up.

## License

MIT
