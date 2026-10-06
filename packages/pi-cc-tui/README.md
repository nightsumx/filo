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

**Interrupts, errors and queued messages** — esc leaves `⎿  Interrupted by user` instead of `Operation aborted`, and failed requests read `⎿  API Error: 529 …`. While pi retries, the working line becomes `⎿  API Error (Overloaded) · Retrying in 3 seconds… (attempt 1/10)`. Messages typed while pi works show as gray `❯ …` lines instead of `Steering: …`.

**`!` commands** — `! cmd` on the user-message background with the output under `⎿`, instead of a bordered `$ cmd` box. pi's 20-line tail preview, ctrl+o expansion and truncation notes stay.

**Exit** — the first ctrl+c shows `Press ctrl+c again to exit` in the second status row; a second press within 800ms exits (pi's own window is 500ms, with no hint).

**Permission modes** — option+m (alt+m off macOS) cycles Claude Code's modes; pi keeps shift+tab for thinking levels. `/permissions` picks one, `--gui-approval ask|edits|auto` sets the starting approval mode (`auto` by default).

| Mode | Edits (`edit`, `write`) | Commands (`bash`, `powershell`) |
|---|---|---|
| `bypassPermissions` (default, pi's behavior) | run | run |
| `default` | ask | ask |
| `acceptEdits` | run | ask |
| `plan` | read-only tools only, until you approve a plan | read-only commands only |

The prompt is Claude Code's rounded box: ↑/↓ and enter, or press 1–3 directly; esc means No. It offers Yes, "Yes, allow all edits during this session" (switches to `acceptEdits`) or "don't ask again for … this session", and No, which stops the turn. Print and JSON modes never ask.

**Plan mode** — the model researches with read-only tools and calls `propose_plan`. The plan opens in a `Ready to code?` box: approve and auto-accept edits, approve and keep asking, or keep planning with a note on what to change.

**Questions** — an `ask` tool for multiple-choice questions, one at a time in a box: 1–9 or ↑/↓ to pick, space to toggle when several answers are allowed, or "Type something" for your own answer. The answers stay in the transcript as `⏺ User answered pi's questions:`.

**Todos** — a `todo` tool (`text`, `status`, optional `activeForm`), drawn as `⏺ Update Todos` with `☐` / bold `☐` / struck-through `☒` under it. The list follows the session branch.

**Subagents** — a `subagent` tool that runs a task in a separate pi, drawn like Claude Code's Task: the latest tool calls while it works, then `⎿  Done (3 tool uses · 12.4k tokens · 41s)`; ctrl+o shows its reply. Its approval prompts come up in your session, tagged with its name.

Approval, plan mode, questions, todos and subagents come from `pi-capabilities`, the same extensions the Pi desktop app uses, bundled in this package. Inside the desktop app they stay off here, since it loads its own.

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
  "excludeRenderers": ["todo", "ask", "propose_plan", "subagent"]
}
```

`showStartupHeader` keeps its header from competing with the welcome box. `excludeRenderers` lets those tools draw themselves; otherwise pi-cc-extensions shows them as generic tool calls. When several tool calls run at once it still groups them into one `Multiple Tools` row.

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
