# pi-capabilities

pi extensions for the features the [Pi desktop app](../../README.md) and [pi-cc-tui](../pi-cc-tui) share: approvals, questions, plan mode, todos, subagents and review. One implementation serves both hosts. In the app (`ctx.mode === 'rpc'`) they publish state and wait for hidden `/gui-…` commands; in the terminal (`'tui'`) they draw Claude Code style dialogs.

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

Each file starts with a comment on its commands, events and rules.

## Layout

- `protocol.ts`: the contract with the hosts. Command names, status keys, `pi.events` names, env vars, and the `details` types that tool results carry into the session file. The app imports it as `@shared/capabilities`.
- `extensions/`: one pi extension per capability.
- `lib/`: process-free parts. `child.ts` (the RPC child behind subagent and review), `readonly.ts` (which shell commands only read), `review.ts`, `todo.ts`, and `mirror.ts` (terminal dialogs the app can answer too).
- `tui/`: terminal dialogs and transcript rendering. Never reached in RPC mode.

## Hosts

- **Desktop app**: sets `PI_KIT_HOST=gui`, so pi-cc-tui's copies stay off in the app's own pi processes. `PI_KIT_APPROVAL_MODE` or `--gui-approval` sets the starting approval mode.
- **pi-cc-tui**: loads them in the terminal. When the app has joined that pi over pi-cc-tui's bridge, approval, ask and plan open on both sides (`DIALOG_EVENTS` in `protocol.ts`), and the first answer closes the other.
- **Subagents**: run with `PI_KIT_SUBAGENT` set. Their parent-only capabilities (ask, plan, subagent, review) stay off.

## Tests

`test/capabilities.test.ts` runs each extension in a real pi against a scripted model (`test/harness.ts`), with no tokens spent. `test/tui-dialog.test.ts` covers the terminal dialogs.

```bash
bunx vitest run test/capabilities.test.ts test/tui-dialog.test.ts
```
