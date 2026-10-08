# pi-capabilities

pi extensions for the features the [Filo desktop app](../../README.md) and [pi-cc-tui](../pi-cc-tui) share: approvals, questions, plan mode, todos, subagents, review and autopilot. One implementation serves both hosts. In the app (`ctx.mode === 'rpc'`) they publish state and wait for hidden `/gui-…` commands; in the terminal (`'tui'`) they draw Claude Code style dialogs.

Private workspace package. The app loads the selected ones with `-e` per thread; pi-cc-tui bundles them when it is packed (`scripts/bundle-capabilities.mjs`).

## Extensions

| Extension | What the model gets | How the user answers |
|---|---|---|
| `approval` | Tool calls that can change something wait for a yes. Modes `ask`, `edits` (project edits run) and `auto` | App: inline prompt. Terminal: permission dialog. No ends the turn |
| `ask` | `ask` tool: up to 4 multiple-choice questions | App: inline form (`/gui-ask-answer`). Terminal: question box |
| `plan` | Read-only tools until `propose_plan` is approved | App: plan card (`/gui-plan-decide`). Terminal: "Ready to code?" |
| `todo` | `todo` tool: a task list, shown again to the model while steps are open | Read-only for the user |
| `subagent` | `subagent` tool: a task run by a second `pi --mode rpc --no-session` | Child approvals come up in the parent session |
| `review` | Nothing: a read-only second pi audits the diff and calls `submit_review` | `/gui-review`, `/gui-review-apply`; `/review` in the terminal |
| `autopilot` | While on: instructions for working unattended, no `ask`, risky calls held. After each run a read-only second pi checks it against the user's rulebook and calls `submit_decision`: a message in the user's place, cards, or done | Cards: `/gui-autopilot-answer` in the app, `/inbox` in the terminal (any session's). Switch: `/gui-autopilot on\|off`, `/autopilot` |

Each file starts with a comment on its commands, events and rules.

## Layout

- `protocol.ts`: the contract with the hosts. Command names, status keys, `pi.events` names, env vars, and the `details` types that tool results carry into the session file. The app imports it as `@shared/capabilities`.
- `extensions/`: one pi extension per capability.
- `lib/`: process-free parts. `child.ts` (the RPC child behind subagent and review), `readonly.ts` (which shell commands only read), `review.ts`, `changes.ts` (the thread's diff, for review and autopilot), `autopilot.ts` (gates, the supervisor's task, valves, board and mail), `todo.ts`, and `mirror.ts` (terminal dialogs the app can answer too).
- `tui/`: terminal dialogs and transcript rendering. Never reached in RPC mode.

## Hosts

- **Desktop app**: sets `PI_KIT_HOST=gui`, so pi-cc-tui's copies stay off in the app's own pi processes. `PI_KIT_APPROVAL_MODE` or `--gui-approval` sets the starting approval mode.
- **pi-cc-tui**: loads them in the terminal. When the app has joined that pi over pi-cc-tui's bridge, approval, ask and plan open on both sides (`DIALOG_EVENTS` in `protocol.ts`), and the first answer closes the other.
- **Subagents**: run with `PI_KIT_SUBAGENT` set. Their parent-only capabilities (ask, plan, subagent, review, autopilot) stay off.

## Autopilot files

Outside any repository, under `<agent dir>/autopilot/` (`~/.pi/agent/autopilot`):

- `rules.md`: the user's rulebook, given to the supervisor in full. `<cwd>/.pi/autopilot.md` adds project rules.
- `config.json`: `{ "paid": [...], "protected": [...] }`. Extra paid-API patterns to hold (on top of `DEFAULT_PAID`) and paths no edit may touch.
- `misses.jsonl`: every time the user stepped in after a decision. `/autopilot learn` turns misses and card answers into `rules.proposed.md` and a card. Accepting it backs up the old rulebook as `rules.<time>.md`.
- `board/<session>.json`, `mail/<session>/`: live sessions with their topic, files and waiting cards, and notes between them. Supervisors in one project see each other, and `/inbox` answers any session's cards.

## Tests

`test/capabilities.test.ts` and `test/autopilot-e2e.test.ts` run the extensions in a real pi against a scripted model (`test/harness.ts`), with no tokens spent. `test/autopilot.test.ts` covers the gates, facts, valves and shared files. `test/tui-dialog.test.ts` covers the terminal dialogs.

```bash
bunx vitest run test/capabilities.test.ts test/autopilot.test.ts test/autopilot-e2e.test.ts test/tui-dialog.test.ts
```
