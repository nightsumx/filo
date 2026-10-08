// A second pi process driven over RPC (`pi --mode rpc --no-session`), shared by subagent and review.
// It owns the wire (JSON lines, request ids), the child's command line (this process's runtime, its
// `-e` capabilities minus the parent-only ones, the same model, thinking level and approval mode),
// and folding the child's events into a SubagentDetails transcript the hosts render. Dialogs the
// child opens (approvals, extension prompts) are forwarded to the parent session's UI.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ApprovalChoice, ApprovalRequest, SubagentDetails } from '../protocol'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promptApproval } from '../tui/approval'
import { serialized } from '../tui/dialog'

const APPROVAL_TITLE_PREFIX = 'gui-approval '
/** Extensions a child never loads: they need the user, who talks to the parent, or would recurse. */
const PARENT_ONLY = new Set(['subagent.ts', 'ask.ts', 'plan.ts', 'review.ts'])
/** Clip sizes for what the details carry; models only get the final reply. */
export const RESULT_CLIP = 2000
const THINKING_CLIP = 8000

export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text

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

/** Set by the Filo app's launcher when pi runs on the app's Electron as node (the app's bundled pi). */
const LAUNCHER_ENV = 'PI_KIT_PI_LAUNCHER'

/** How to start pi again: this process's runtime plus its CLI script when it is one. */
function piCommand(): { file: string, args: string[], env?: Record<string, string> } {
    // Under node or bun the script is argv[1]; a global install runs it as `bin/pi`, without an extension.
    const script = process.argv[1]
    // Electron needs the flag to act as node; the launcher drops it again inside the child.
    const launcher = process.versions.electron ? process.env[LAUNCHER_ENV] : undefined
    if (launcher && script)
        return { file: process.execPath, args: [launcher, script], env: { ELECTRON_RUN_AS_NODE: '1' } }
    const runtime = /^(?:node|bun)(?:\.exe)?$/i.test(path.basename(process.execPath))
    return script && (runtime || /\.[cm]?[jt]s$/.test(script))
        ? { file: process.execPath, args: [script] }
        : { file: process.execPath, args: [] }
}

/**
 * Follows the approval capability's mode (pi.events) so a child asks the same way as its parent.
 * Call once from the extension factory.
 */
export function followApprovalMode(pi: ExtensionAPI): () => string | undefined {
    let mode: string | undefined
    pi.events.on('gui-approval:mode', (value) => {
        mode = typeof value === 'string' ? value : undefined
    })
    return () => {
        const current = mode ?? pi.getFlag('gui-approval')
        return typeof current === 'string' ? current : undefined
    }
}

/**
 * The child's command line and environment: RPC without a session file, the parent's capabilities,
 * model, thinking level and approval mode, then `extra`.
 */
export function childLaunch(pi: ExtensionAPI, ctx: ExtensionContext, approvalMode: string | undefined, extra: string[] = []): { args: string[], env: Record<string, string> } {
    const args = ['--mode', 'rpc', '--no-session', ...childExtensionArgs(process.argv)]
    const model = ctx.model
    if (model)
        args.push('--provider', model.provider, '--model', model.id)
    args.push('--thinking', pi.getThinkingLevel())
    if (approvalMode && args.some(a => path.basename(a) === 'approval.ts'))
        args.push('--gui-approval', approvalMode)
    args.push(...extra)
    // Approval loaded without -e (pi-cc-tui) reads the mode from the environment.
    return { args, env: approvalMode ? { PI_KIT_APPROVAL_MODE: approvalMode } : {} }
}

export class Child {
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
        this.proc = spawn(command.file, [...command.args, ...args], { cwd, env: { ...process.env, PI_KIT_SUBAGENT: '1', ...command.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
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
                resolve({ success: false, error: 'the agent process exited' })
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
            return Promise.resolve({ success: false, error: 'the agent process exited' })
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

export function newRun(title: string, task: string, ctx: ExtensionContext): SubagentDetails {
    return {
        kind: 'subagent',
        status: 'running',
        title,
        task,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        messages: [],
        tools: {},
        steering: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        startedAt: Date.now(),
    }
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

/** Folds one child event into its transcript; true when the details changed. */
export function recordEvent(details: SubagentDetails, event: any): boolean {
    switch (event.type) {
        case 'message_start':
            if (event.message?.role === 'assistant')
                details.streaming = { ...event.message, content: [] }
            return true
        case 'message_update':
            if (details.streaming)
                applyDelta(details.streaming, event.assistantMessageEvent)
            return true
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
            return true
        }
        case 'tool_execution_start':
            details.tools[event.toolCallId] = { startedAt: Date.now() }
            return true
        case 'tool_execution_update': {
            const partial = event.partialResult
            const text = (partial?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
            details.tools[event.toolCallId] = {
                startedAt: details.tools[event.toolCallId]?.startedAt ?? Date.now(),
                partial: { content: [{ type: 'text', text: clip(text, RESULT_CLIP) }], details: partial?.details },
            }
            return true
        }
        case 'tool_execution_end':
            delete details.tools[event.toolCallId]
            return true
        case 'queue_update':
            details.steering = [...(event.steering ?? [])]
            return true
        default:
            return false
    }
}

/** Clears the live parts once the child settled, and decides done / failed for a run still marked running. */
export function finishRun(details: SubagentDetails) {
    details.streaming = undefined
    details.tools = {}
    details.steering = []
    details.endedAt = Date.now()
    if (details.status !== 'running')
        return
    const last = details.messages.findLast((m: any) => m.role === 'assistant') as any
    if (last?.stopReason === 'error') {
        details.status = 'failed'
        details.error = last.errorMessage ?? 'The request failed.'
    }
    else {
        details.status = 'done'
    }
}

/** The run's usage in pi's tool-result shape, so session totals include the child. */
export function runUsage(details: SubagentDetails) {
    const u = details.usage
    return {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
    }
}

export function lastReply(messages: any[]): string {
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

/** The child's tool calls so far, in order. */
export function toolCalls(details: SubagentDetails): { name: string, arguments: Record<string, unknown> }[] {
    const messages = [...details.messages, ...(details.streaming ? [details.streaming] : [])] as any[]
    return messages.flatMap(m => m?.role === 'assistant' ? (m.content ?? []).filter((c: any) => c.type === 'toolCall') : [])
}

/**
 * Forwards a child dialog to this session's UI and answers the child. Approval requests get `agent`
 * (the child's title) so the user sees whose call it is.
 */
export async function forwardDialog(child: Child, agent: string, event: any, ctx: ExtensionContext, signal?: AbortSignal) {
    const opts = { signal, timeout: event.timeout }
    let response: Record<string, unknown>
    if (event.method === 'select') {
        let title: string = event.title ?? ''
        if (title.startsWith(APPROVAL_TITLE_PREFIX)) {
            const request: ApprovalRequest = { ...JSON.parse(title.slice(APPROVAL_TITLE_PREFIX.length)), agent }
            if (ctx.mode === 'tui') {
                const choice = await serialized(() => promptApproval(ctx, request, undefined, (event.options ?? []) as ApprovalChoice[]))
                child.send({ type: 'extension_ui_response', id: event.id, ...(choice ? { value: choice } : { cancelled: true }) })
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
    child.send({ type: 'extension_ui_response', id: event.id, ...response })
}
