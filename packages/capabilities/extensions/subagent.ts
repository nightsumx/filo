// subagent: hands a self-contained task to a second pi process (`pi --mode rpc --no-session`) and
// returns its final reply. Running the child over RPC keeps both directions open:
//   down: every child event updates SubagentDetails (its transcript, running tools, queued steers),
//         streamed through onUpdate and kept in the result for history;
//   up:   /gui-subagent-steer <toolCallId> <message>   steer the child mid-run
//         /gui-subagent-cancel <toolCallId>            stop only the child; the parent carries on
// Dialogs the child opens (approvals, extension prompts) are forwarded to this session's UI, with
// the subagent's title added to approval requests. The child loads this process's `-e` extensions
// except subagent (no recursion), ask and plan (both need the user, who talks to the parent); its
// environment carries PI_KIT_SUBAGENT so copies loaded another way (pi-cc-tui) stay off too.
// In the terminal the call draws as Claude Code's Task row: the latest tool, then a Done summary.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ApprovalChoice, ApprovalRequest, GuiCommands, SubagentDetails } from '../protocol'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { promptApproval } from '../tui/approval'
import { serialized } from '../tui/dialog'
import { count, duration, hang, header, oneLine } from '../tui/render'

const STEER_COMMAND: GuiCommands['subagentSteer'] = 'gui-subagent-steer'
const CANCEL_COMMAND: GuiCommands['subagentCancel'] = 'gui-subagent-cancel'
const APPROVAL_TITLE_PREFIX = 'gui-approval '
/** Extensions the child does not load. */
const PARENT_ONLY = new Set(['subagent.ts', 'ask.ts', 'plan.ts'])
/** Clip sizes for what the details carry; the model only gets the final reply. */
const RESULT_CLIP = 2000
const THINKING_CLIP = 8000
const REPLY_CLIP = 30_000
const UPDATE_INTERVAL = 150

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text

/** `-e` values from this process's command line, without parent-only capabilities. */
export function childExtensionArgs(argv: string[]): string[] {
    const out: string[] = []
    for (let i = 0; i < argv.length; i++) {
        if ((argv[i] === '-e' || argv[i] === '--extension') && argv[i + 1]) {
            if (!PARENT_ONLY.has(path.basename(argv[i + 1])))
                out.push('-e', argv[i + 1])
            i++
        }
    }
    return out
}

/** How to start pi again: this process's runtime plus its CLI script when it is one. */
function piCommand(): { file: string, args: string[] } {
    // Under node or bun the script is argv[1]; a global install runs it as `bin/pi`, without an extension.
    const script = process.argv[1]
    const runtime = /^(?:node|bun)(?:\.exe)?$/i.test(path.basename(process.execPath))
    return script && (runtime || /\.[cm]?[jt]s$/.test(script))
        ? { file: process.execPath, args: [script] }
        : { file: process.execPath, args: [] }
}

/** Child message with tool results and thinking clipped, images dropped. */
function clipMessage(message: any): any {
    if (message?.role === 'toolResult') {
        const content = (message.content ?? []).map((c: any) => c.type === 'text' ? { type: 'text', text: clip(c.text ?? '', RESULT_CLIP) } : { type: 'text', text: '[image]' })
        return { ...message, content }
    }
    if (message?.role === 'assistant')
        return { ...message, content: (message.content ?? []).map((c: any) => c.type === 'thinking' ? { ...c, thinking: clip(c.thinking ?? '', THINKING_CLIP) } : c) }
    if (message?.role === 'user' && Array.isArray(message.content))
        return { ...message, content: message.content.filter((c: any) => c.type === 'text') }
    return message
}

function lastReply(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'assistant') {
            const text = (m.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
            if (text)
                return text
        }
    }
    return ''
}

class Child {
    private proc: ChildProcessWithoutNullStreams
    private buffer = ''
    private pending = new Map<string, (r: any) => void>()
    private next = 0
    private stderr = ''
    exited = false
    onEvent: (event: any) => void = () => {}
    onExit: (error: string) => void = () => {}

    constructor(args: string[], cwd: string, env: Record<string, string>) {
        const command = piCommand()
        this.proc = spawn(command.file, [...command.args, ...args], { cwd, env: { ...process.env, PI_KIT_SUBAGENT: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
        this.proc.stdout.setEncoding('utf8')
        this.proc.stdout.on('data', (chunk: string) => {
            this.buffer += chunk
            let nl: number
            while ((nl = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, nl).trim()
                this.buffer = this.buffer.slice(nl + 1)
                if (!line)
                    continue
                let record: any
                try {
                    record = JSON.parse(line)
                }
                catch {
                    continue
                }
                if (record.type === 'response' && this.pending.has(record.id)) {
                    this.pending.get(record.id)!(record)
                    this.pending.delete(record.id)
                }
                else {
                    this.onEvent(record)
                }
            }
        })
        this.proc.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk).slice(-8000)
        })
        this.proc.stdin.on('error', () => {})
        const exit = () => {
            if (this.exited)
                return
            this.exited = true
            for (const resolve of this.pending.values())
                resolve({ success: false, error: 'subagent exited' })
            this.pending.clear()
            this.onExit(this.stderr.trim().split('\n').slice(-5).join('\n'))
        }
        this.proc.on('exit', exit)
        this.proc.on('error', (e) => {
            this.stderr += `\n${e.message}`
            exit()
        })
    }

    request(command: Record<string, unknown>): Promise<any> {
        if (this.exited)
            return Promise.resolve({ success: false, error: 'subagent exited' })
        const id = `sub-${++this.next}`
        return new Promise((resolve) => {
            this.pending.set(id, resolve)
            this.send({ ...command, id })
        })
    }

    send(record: Record<string, unknown>) {
        if (!this.exited)
            this.proc.stdin.write(`${JSON.stringify(record)}\n`)
    }

    stop() {
        if (this.exited)
            return
        this.proc.stdin.end()
        setTimeout(() => !this.exited && this.proc.kill('SIGTERM'), 3000).unref()
    }
}

interface Run {
    child: Child
    details: SubagentDetails
    cancel: () => void
}

/** Rebuilds the streaming assistant message from wire deltas (they carry no snapshots). */
function applyDelta(message: any, update: any) {
    const i = update?.contentIndex
    if (typeof i !== 'number')
        return
    const block = message.content[i]
    switch (update.type) {
        case 'text_start':
            message.content[i] = { type: 'text', text: '' }
            break
        case 'text_delta':
            message.content[i] = { type: 'text', text: (block?.text ?? '') + update.delta }
            break
        case 'thinking_start':
            message.content[i] = { type: 'thinking', thinking: '' }
            break
        case 'thinking_delta':
            message.content[i] = { type: 'thinking', thinking: (block?.thinking ?? '') + update.delta }
            break
        case 'text_end':
        case 'thinking_end':
            if (typeof update.content === 'string')
                message.content[i] = update.type === 'text_end' ? { type: 'text', text: update.content } : { type: 'thinking', thinking: update.content }
            break
        case 'toolcall_start':
            message.content[i] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {} }
            break
        case 'toolcall_end':
            if (update.toolCall)
                message.content[i] = update.toolCall
            break
        default:
            break
    }
}

/** The child's tool calls so far, in order. */
function toolCalls(details: SubagentDetails): { name: string, arguments: Record<string, unknown> }[] {
    const messages = [...details.messages, ...(details.streaming ? [details.streaming] : [])] as any[]
    return messages.flatMap(m => m?.role === 'assistant' ? (m.content ?? []).filter((c: any) => c.type === 'toolCall') : [])
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
    /** Mirrors the approval capability's mode (pi.events), so the child asks the same way. */
    let approvalMode: string | undefined
    pi.events.on('gui-approval:mode', (mode) => {
        approvalMode = typeof mode === 'string' ? mode : undefined
    })

    /** Forwards a child dialog to this session's UI and answers the child. */
    async function forwardDialog(run: Run, event: any, ctx: ExtensionContext, signal?: AbortSignal) {
        const opts = { signal, timeout: event.timeout }
        let response: Record<string, unknown>
        if (event.method === 'select') {
            let title: string = event.title ?? ''
            if (title.startsWith(APPROVAL_TITLE_PREFIX)) {
                const request: ApprovalRequest = { ...JSON.parse(title.slice(APPROVAL_TITLE_PREFIX.length)), agent: run.details.title }
                if (ctx.mode === 'tui') {
                    const choice = await serialized(() => promptApproval(ctx, request, undefined, (event.options ?? []) as ApprovalChoice[]))
                    run.child.send({ type: 'extension_ui_response', id: event.id, ...(choice ? { value: choice } : { cancelled: true }) })
                    return
                }
                title = APPROVAL_TITLE_PREFIX + JSON.stringify(request)
            }
            const value = await ctx.ui.select(title, event.options ?? [], opts)
            response = value === undefined ? { cancelled: true } : { value }
        }
        else if (event.method === 'confirm') {
            response = { confirmed: await ctx.ui.confirm(event.title ?? '', event.message ?? '', opts) }
        }
        else if (event.method === 'input' || event.method === 'editor') {
            const value = event.method === 'input' ? await ctx.ui.input(event.title ?? '', event.placeholder, opts) : await ctx.ui.editor(event.title ?? '', event.prefill)
            response = value === undefined ? { cancelled: true } : { value }
        }
        else {
            return
        }
        run.child.send({ type: 'extension_ui_response', id: event.id, ...response })
    }

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
            task: Type.String({ description: 'Complete, self-contained instructions, including what the final reply must contain' }),
        }),
        // Its child's calls are approved one by one, so launching one needs no approval.
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const model = ctx.model
            const args = ['--mode', 'rpc', '--no-session', ...childExtensionArgs(process.argv)]
            if (model)
                args.push('--provider', model.provider, '--model', model.id)
            args.push('--thinking', pi.getThinkingLevel())
            const mode = approvalMode ?? pi.getFlag('gui-approval')
            if (typeof mode === 'string' && args.some(a => path.basename(a) === 'approval.ts'))
                args.push('--gui-approval', mode)

            const details: SubagentDetails = {
                kind: 'subagent',
                status: 'running',
                title: params.title.trim() || 'Subagent',
                task: params.task,
                model: model ? `${model.provider}/${model.id}` : undefined,
                messages: [],
                tools: {},
                steering: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
                startedAt: Date.now(),
            }
            // Approval loaded without -e (pi-cc-tui) reads the mode from the environment.
            const child = new Child(args, ctx.cwd, typeof mode === 'string' ? { PI_KIT_APPROVAL_MODE: mode } : {})

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

            const done = new Promise<void>((resolve) => {
                const run: Run = {
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
                    switch (event.type) {
                        case 'message_start':
                            if (event.message?.role === 'assistant')
                                details.streaming = { ...event.message, content: [] }
                            break
                        case 'message_update':
                            if (details.streaming)
                                applyDelta(details.streaming, event.assistantMessageEvent)
                            break
                        case 'message_end': {
                            const message = event.message
                            if (message?.role === 'assistant') {
                                details.streaming = undefined
                                const u = message.usage
                                if (u) {
                                    details.usage.input += u.input ?? 0
                                    details.usage.output += u.output ?? 0
                                    details.usage.cacheRead += u.cacheRead ?? 0
                                    details.usage.cacheWrite += u.cacheWrite ?? 0
                                    details.usage.cost += u.cost?.total ?? 0
                                }
                            }
                            // System messages hold the child's whole prompt; the card has no use for them.
                            if (message && message.role !== 'system')
                                details.messages.push(clipMessage(message))
                            break
                        }
                        case 'tool_execution_start':
                            details.tools[event.toolCallId] = { startedAt: Date.now() }
                            break
                        case 'tool_execution_update': {
                            const partial = event.partialResult
                            const text = (partial?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
                            details.tools[event.toolCallId] = {
                                startedAt: details.tools[event.toolCallId]?.startedAt ?? Date.now(),
                                partial: { content: [{ type: 'text', text: clip(text, RESULT_CLIP) }], details: partial?.details },
                            }
                            break
                        }
                        case 'tool_execution_end':
                            delete details.tools[event.toolCallId]
                            break
                        case 'queue_update':
                            details.steering = [...(event.steering ?? [])]
                            break
                        case 'extension_ui_request':
                            void forwardDialog(run, event, ctx, signal).catch(() => child.send({ type: 'extension_ui_response', id: event.id, cancelled: true }))
                            return
                        case 'agent_settled':
                            resolve()
                            return
                        default:
                            return
                    }
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
            child.stop()
            if (timer)
                clearTimeout(timer)

            details.streaming = undefined
            details.tools = {}
            details.steering = []
            details.endedAt = Date.now()
            const last = details.messages.findLast((m: any) => m.role === 'assistant') as any
            if (details.status === 'running') {
                if (last?.stopReason === 'error') {
                    details.status = 'failed'
                    details.error = last.errorMessage ?? 'The subagent request failed.'
                }
                else {
                    details.status = 'done'
                }
            }

            const reply = clip(lastReply(details.messages), REPLY_CLIP)
            const usage = {
                input: details.usage.input,
                output: details.usage.output,
                cacheRead: details.usage.cacheRead,
                cacheWrite: details.usage.cacheWrite,
                totalTokens: details.usage.input + details.usage.output + details.usage.cacheRead + details.usage.cacheWrite,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: details.usage.cost },
            }
            if (details.status === 'cancelled') {
                const note = signal?.aborted ? 'The subagent was stopped with the run.' : 'The user cancelled this subagent. Do not start it again; continue without it or ask the user.'
                return { content: [{ type: 'text', text: reply ? `${note}\n\nIts last reply before stopping:\n${reply}` : note }], details, usage }
            }
            if (details.status === 'failed')
                return { content: [{ type: 'text', text: `The subagent failed: ${details.error}${reply ? `\n\nIts last reply:\n${reply}` : ''}` }], details, usage, isError: true }
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
