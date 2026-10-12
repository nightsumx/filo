// subagent: hands a self-contained task to a second pi process (`pi --mode rpc`) and returns its
// final reply. Each run keeps its own pi session under <agent dir>/subagent-sessions, named after the
// call that started it: a run that fails (often a provider error hundreds of steps in) or is stopped
// keeps it, so a later call with `resume` continues with the whole context instead of starting over.
// A run that finishes deletes it; kept ones go after a week. Running the child over RPC keeps both directions open:
//   down: every child event updates SubagentDetails (its transcript, running tools, queued steers),
//         streamed through onUpdate and kept in the result for history;
//   up:   /gui-subagent-steer <toolCallId> <message>   steer the child mid-run
//         /gui-subagent-cancel <toolCallId>            stop only the child; the parent carries on
// Dialogs the child opens (approvals, extension prompts) are forwarded to this session's UI, with
// the subagent's title added to approval requests. The child loads this process's `-e` extensions
// except subagent (no recursion), ask and plan (both need the user, who talks to the parent); its
// environment carries PI_KIT_SUBAGENT so copies loaded another way (pi-cc-tui) stay off too.
// A child that sends nothing for longer than the prompt cache lives (a silent command, a hung request)
// gets one notice per quiet spell; while it waits on a dialog it is the user's turn, not a stall.
// In the terminal the call draws as Claude Code's Task row: the latest tool, then a Done summary.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { GuiCommands, SubagentDetails } from '../protocol'
import type { Child as ChildProcess } from '../lib/child'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { getAgentDir, getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { Child, childLaunch, finishRun, followApprovalMode, forwardDialog, lastReply, newRun, recordEvent, runUsage, toolCalls } from '../lib/child'
import { cacheTtlMs } from '../lib/promptCache'
import { clip } from '../lib/review'
import { count, duration, hang, header, oneLine } from '../tui/render'

const STEER_COMMAND: GuiCommands['subagentSteer'] = 'gui-subagent-steer'
const CANCEL_COMMAND: GuiCommands['subagentCancel'] = 'gui-subagent-cancel'
const REPLY_CLIP = 30_000
const UPDATE_INTERVAL = 150
const KEEP_MS = 7 * 24 * 60 * 60_000

interface Run {
    /** The session it runs in: the id of the call that started it. */
    id: string
    child: ChildProcess
    details: SubagentDetails
    cancel: () => void
}

/** `Read(src/app.ts)`: the tool and its most telling argument. */
function describeCall(call: { name: string, arguments: Record<string, unknown> }): string {
    const args = call.arguments ?? {}
    const main = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'title'].map(k => args[k]).find(v => typeof v === 'string')
    const name = call.name.charAt(0).toUpperCase() + call.name.slice(1)
    return main ? `${name}(${oneLine(String(main), 60)})` : name
}

export default function (pi: ExtensionAPI) {
    const runs = new Map<string, Run>()
    const approvalMode = followApprovalMode(pi)

    pi.registerTool({
        name: 'subagent',
        label: 'Subagent',
        description: 'Run a self-contained task in a separate pi agent with the same tools and project, and get its final reply. The user can watch, steer or cancel it.',
        promptSnippet: 'Delegate a self-contained subtask to a separate agent',
        promptGuidelines: [
            'Use subagent for self-contained work that needs many tool calls (searching or investigating a codebase, an independent change in separate files), so your own context stays small. Several subagent calls in one message run in parallel.',
            'A subagent knows nothing of this conversation: put every detail it needs (paths, constraints, what to report back) in task.',
        ],
        parameters: Type.Object({
            title: Type.String({ description: 'A 3-6 word label shown to the user' }),
            task: Type.String({ description: 'Complete, self-contained instructions, including what the final reply must contain. With resume: what to do next' }),
            resume: Type.Optional(Type.String({ description: 'The id of a subagent that failed or was stopped, to continue it with everything it already did instead of starting over' })),
        }),
        // Its child's calls are approved one by one, so launching one needs no approval.
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const dir = path.join(getAgentDir(), 'subagent-sessions')
            mkdirSync(dir, { recursive: true })
            for (const name of readdirSync(dir)) {
                const file = path.join(dir, name)
                if (Date.now() - statSync(file).mtimeMs > KEEP_MS)
                    rmSync(file, { force: true })
            }
            const id = params.resume?.trim() || toolCallId
            const file = path.join(dir, `${encodeURIComponent(id)}.jsonl`)
            const details = newRun(params.title.trim() || 'Subagent', params.task, ctx)
            const refusal = params.resume && !existsSync(file)
                ? `No subagent "${id}" to resume: finished ones are not kept, stopped ones for a week. Start a new one.`
                : [...runs.values()].some(r => r.id === id) ? `Subagent "${id}" is still running.` : undefined
            if (refusal) {
                details.status = 'failed'
                details.error = refusal
                finishRun(details)
                return { content: [{ type: 'text', text: refusal }], details, isError: true }
            }

            const launch = childLaunch(pi, ctx, approvalMode(), ['--session', file])
            const child = new Child(launch.args, ctx.cwd, launch.env)

            // Throttled (first change right away, then at most every UPDATE_INTERVAL): streaming tokens
            // would otherwise send the whole details per delta.
            let timer: ReturnType<typeof setTimeout> | undefined
            let flushedAt = 0
            const flush = () => {
                timer = undefined
                flushedAt = Date.now()
                onUpdate?.({ content: [{ type: 'text', text: `Subagent ${details.status}` }], details: { ...details, messages: [...details.messages], tools: { ...details.tools } } })
            }
            const changed = () => {
                timer ??= setTimeout(flush, Math.max(0, flushedAt + UPDATE_INTERVAL - Date.now()))
            }

            let quietSince = Date.now()
            let dialogs = 0
            let warned = false
            const stallMs = cacheTtlMs(ctx.model)
            const watch = setInterval(() => {
                if (dialogs || warned || Date.now() - quietSince < stallMs)
                    return
                warned = true
                const call = toolCalls(details).at(-1)
                const stop = ctx.mode === 'tui' ? '按 Esc 停下这一轮' : '可以在它的卡片里引导或停止它'
                ctx.ui.notify(`子 Agent「${details.title}」已经 ${Math.round((Date.now() - quietSince) / 60_000)} 分钟没有动静${call ? `，停在 ${describeCall(call)}` : ''}。${stop}。`, 'warning')
            }, Math.min(10_000, stallMs))

            const done = new Promise<void>((resolve) => {
                const run: Run = {
                    id,
                    child,
                    details,
                    cancel: () => {
                        if (details.status !== 'running')
                            return
                        details.status = 'cancelled'
                        void child.request({ type: 'abort' }).finally(resolve)
                    },
                }
                runs.set(toolCallId, run)

                child.onEvent = (event) => {
                    quietSince = Date.now()
                    warned = false
                    if (event.type === 'extension_ui_request') {
                        dialogs++
                        void forwardDialog(child, details.title, event, ctx, signal)
                            .catch(() => child.send({ type: 'extension_ui_response', id: event.id, cancelled: true }))
                            .finally(() => {
                                dialogs--
                                quietSince = Date.now()
                            })
                        return
                    }
                    if (event.type === 'agent_settled') {
                        resolve()
                        return
                    }
                    if (recordEvent(details, event))
                        changed()
                }
                child.onExit = (error) => {
                    if (details.status === 'running') {
                        details.status = 'failed'
                        details.error = error || 'The subagent process exited.'
                    }
                    resolve()
                }

                const onAbort = () => run.cancel()
                if (signal?.aborted)
                    return run.cancel()
                signal?.addEventListener('abort', onAbort, { once: true })

                void child.request({ type: 'prompt', message: params.task }).then((r) => {
                    if (!r.success && details.status === 'running') {
                        details.status = 'failed'
                        details.error = r.error ?? 'The subagent rejected the task.'
                        resolve()
                    }
                })
            })

            await done
            runs.delete(toolCallId)
            finishRun(details)
            if (details.status === 'done') {
                if (child.exited)
                    rmSync(file, { force: true })
                else
                    child.onExit = () => rmSync(file, { force: true })
            }
            child.stop()
            clearInterval(watch)
            if (timer)
                clearTimeout(timer)

            const reply = clip(lastReply(details.messages), REPLY_CLIP)
            const usage = runUsage(details)
            const resume = `To continue it with everything it already did, call subagent with resume: "${id}" instead of starting a new one.`
            if (details.status === 'cancelled') {
                const note = signal?.aborted ? `The subagent was stopped with the run. ${resume}` : `The user cancelled this subagent. Do not start it again; continue without it or ask the user. If the user asks to continue it: ${resume}`
                return { content: [{ type: 'text', text: reply ? `${note}\n\nIts last reply before stopping:\n${reply}` : note }], details, usage }
            }
            if (details.status === 'failed')
                return { content: [{ type: 'text', text: `The subagent failed: ${details.error}\n${resume}${reply ? `\n\nIts last reply:\n${reply}` : ''}` }], details, usage, isError: true }
            return { content: [{ type: 'text', text: reply || '(The subagent finished without a reply.)' }], details, usage }
        },

        renderShell: 'self',
        renderCall(args, theme, context) {
            return header(theme, context, 'Task', args?.title ? oneLine(String(args.title), 60) : undefined)
        },
        renderResult(result, options, theme) {
            const details = result.details as SubagentDetails | undefined
            if (!details || details.kind !== 'subagent')
                return new Text('', 0, 0)
            const calls = toolCalls(details)
            const uses = `${calls.length} tool use${calls.length === 1 ? '' : 's'}`
            if (details.status === 'running') {
                const recent = calls.slice(-3).map(c => describeCall(c))
                const more = calls.length > 3 ? [theme.fg('dim', `+${calls.length - 3} more tool uses`)] : []
                return hang(theme, recent.length ? [...more, ...recent] : [theme.fg('dim', 'Starting…')])
            }
            const tokens = details.usage.input + details.usage.output + details.usage.cacheRead + details.usage.cacheWrite
            const took = duration((details.endedAt ?? Date.now()) - details.startedAt)
            const summary = details.status === 'done'
                ? `Done (${uses} · ${count(tokens)} tokens · ${took})`
                : details.status === 'cancelled'
                    ? theme.fg('error', 'Interrupted')
                    : theme.fg('error', `Failed: ${oneLine(details.error ?? 'unknown error', 120)}`)
            const box = new Container()
            box.addChild(hang(theme, [summary]))
            const reply = result.content.find(c => c.type === 'text')?.text
            if (options.expanded && reply && details.status === 'done')
                box.addChild(new Markdown(reply, 5, 0, getMarkdownTheme()))
            return box
        },
    })

    pi.registerCommand(STEER_COMMAND, {
        description: 'Internal: steer a running subagent',
        handler: async (args, ctx) => {
            const space = args.indexOf(' ')
            const id = space < 0 ? args.trim() : args.slice(0, space)
            const message = space < 0 ? '' : args.slice(space + 1).trim()
            const run = runs.get(id)
            if (!run || run.details.status !== 'running')
                return ctx.ui.notify('这个子 Agent 已经结束了', 'warning')
            if (!message)
                return
            const response = await run.child.request({ type: 'steer', message })
            if (!response.success)
                ctx.ui.notify(`引导失败：${response.error ?? ''}`, 'error')
        },
    })

    pi.registerCommand(CANCEL_COMMAND, {
        description: 'Internal: cancel a running subagent',
        handler: async (args, ctx) => {
            const run = runs.get(args.trim())
            if (!run)
                return ctx.ui.notify('这个子 Agent 已经结束了', 'warning')
            run.cancel()
        },
    })

    pi.on('session_shutdown', async () => {
        for (const run of runs.values()) {
            run.cancel()
            run.child.stop()
        }
    })
}
