// Codex app-server native adapter: drives `codex app-server` (JSON-RPC over stdio, checked against
// codex 0.160) and speaks pi RPC to the renderer through AcpTranscript. Over codex-acp it adds
// asking again from a message (thread/revert), forking at a message (thread/fork beforeTurnId),
// Codex's questions (item/tool/requestUserInput) and plan mode (collaborationMode 'plan', the
// proposed plan reviewed in the thread), and steering a running turn (turn/steer).
//
// Codex items map to ACP-shaped tool calls whose pi calls the adapter sets itself (`_meta.piCalls`):
// commands are bash (or read / ls / grep when Codex parsed them so), file changes are one write /
// edit / delete per file with the unified diff as the edit's patch.

import type { AcpAgentCaps, AcpAgentSpec, AcpConfigOption } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import type { AgentMessage, ImageContent, PiEvent, PiModel, RpcResponse, ToolCall } from '@shared/pi'
import type { ApprovalChoice, ApprovalRequest, AskAnswer, AskQuestion, AskResponse, PlanDecision, SubagentDetails } from '@shared/capabilities'
import type { AgentAdapter, AgentAdapterCallbacks, AgentAdapterOptions } from '../acp/adapter'
import type { PromptUsage } from '../acp/transcript'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { acpSessionKey } from '@shared/agents'
import { APPROVAL_TITLE_PREFIX } from '@shared/capabilities'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tr } from '../i18n'
import { AcpConnection, RpcError } from '../acp/connection'
import { AcpTranscript } from '../acp/transcript'

const STDERR_LIMIT = 64 * 1024

export interface CodexLaunch {
    file: string
    args: string[]
    windowsVerbatimArguments?: boolean
    env: Record<string, string>
}

/** What the native adapter does; the renderer gates features on it. */
export const CODEX_CAPS: AcpAgentCaps = {
    images: true,
    steering: true,
    fork: true,
    delete: true,
    list: true,
    xai: false,
    forkAt: true,
    rewind: true,
    ask: true,
    plan: true,
}

/**
 * Codex sends the client's name as the `originator` header of model requests. Relays in front of
 * the API can pass only Codex clients' names (codex_cli_rs, codex_vscode, codex_exec, …): with any
 * other name every turn failed with "high demand" after the retries. So the name starts with `codex_`.
 */
const CLIENT_INFO = { name: 'codex_filo', title: 'Filo', version: '1' }

/** What Codex TUI sends when the user accepts a proposed plan. */
const IMPLEMENT_PLAN = 'Implement the plan.'

/** Sessions Codex started for itself (subagents, reviews, compaction) stay out of the list. */
const LISTED_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'unknown']

// ---------------------------------------------------------------- modes

type ModeId = 'read-only' | 'auto' | 'full-access' | 'plan'

/** Approval and sandbox per mode, sent with every turn (Codex keeps them for the turns after). */
const MODES: Record<ModeId, { approvalPolicy: string, sandboxPolicy: { type: string } }> = {
    'read-only': { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } },
    'auto': { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } },
    'full-access': { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
    // Codex's plan mode explores and asks, and makes no changes until the plan is accepted.
    'plan': { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } },
}

const modeOption = (current: ModeId): AcpConfigOption => ({
    id: 'mode',
    name: tr('模式', 'Mode'),
    category: 'mode',
    currentValue: current,
    options: [
        { value: 'read-only', name: tr('只读', 'Read only'), description: tr('能读文件；改文件、跑命令前先问你', 'Reads files; asks before edits and commands') },
        { value: 'auto', name: tr('自动', 'Auto'), description: tr('在项目里改文件、跑命令；越出项目或联网前问你', 'Edits and runs commands in the project; asks before going outside it or online') },
        { value: 'full-access', name: tr('完全访问', 'Full access'), description: tr('不问，不受沙箱限制', 'Never asks, no sandbox') },
        { value: 'plan', name: tr('计划', 'Plan'), description: tr('只读探索并写计划，你批准后再动手', 'Explores read-only and writes a plan; changes start once you approve it') },
    ],
})

/** The mode a thread opens in, from the sandbox Codex reports (the user's own config). */
/** Codex lets one process write a thread at a time. */
const ACTIVE_WRITER = /active writer/i

function modeOf(sandbox: any, collaboration: any): ModeId {
    if (collaboration?.mode === 'plan')
        return 'plan'
    const type = typeof sandbox === 'string' ? sandbox : sandbox?.type
    if (type === 'dangerFullAccess' || type === 'danger-full-access')
        return 'full-access'
    if (type === 'readOnly' || type === 'read-only')
        return 'read-only'
    return 'auto'
}

// ---------------------------------------------------------------- items → pi calls

const call = (id: string, name: string, args: Record<string, any>): ToolCall => ({ type: 'toolCall', id, name, arguments: args })
const textBlock = (t: string) => [{ type: 'content', content: { type: 'text', text: t } }]

/** `/bin/zsh -lc 'cmd'` → `cmd`: the shell wrapper Codex runs every command in. */
export function displayCommand(command: string): string {
    const m = /^(?:\/\S+\/)?(?:ba|z)?sh -lc '([\s\S]*)'$/.exec(command)
    return m ? m[1].replaceAll(`'\\''`, `'`) : command
}

/** A command as pi shows it: a read / listing / search when Codex parsed it as exactly one. */
function commandCall(item: any): ToolCall {
    const actions: any[] = Array.isArray(item.commandActions) ? item.commandActions : []
    const command = displayCommand(String(item.command ?? ''))
    if (actions.length === 1) {
        const a = actions[0]
        if (a?.type === 'read' && typeof a.path === 'string')
            return call(item.id, 'read', { path: a.path })
        if (a?.type === 'listFiles')
            return call(item.id, 'ls', { path: a.path ?? '.' })
        if (a?.type === 'search' && a.query)
            return call(item.id, 'grep', { pattern: a.query, ...(a.path ? { path: a.path } : {}) })
    }
    return call(item.id, 'bash', { command })
}

/** A unified diff's hunks as the edits pi's edit view diffs while the change is pending. */
function hunkEdits(diff: string): { oldText: string, newText: string }[] {
    const edits: { oldText: string, newText: string }[] = []
    let current: { old: string[], new: string[] } | null = null
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) {
            current = { old: [], new: [] }
            edits.push(current as any)
            continue
        }
        if (!current || line.startsWith('\\'))
            continue
        if (line.startsWith('-'))
            current.old.push(line.slice(1))
        else if (line.startsWith('+'))
            current.new.push(line.slice(1))
        else {
            current.old.push(line.slice(1))
            current.new.push(line.slice(1))
        }
    }
    return (edits as any[]).map(e => ({ oldText: e.old.join('\n'), newText: e.new.join('\n') }))
}

/** One pi call per changed file: an add is a write, an update an edit (its diff the patch), a delete a delete. */
function fileChangeCalls(item: any): { calls: ToolCall[], details: Record<string, unknown> } {
    const calls: ToolCall[] = []
    const details: Record<string, unknown> = {}
    const changes: any[] = Array.isArray(item.changes) ? item.changes : []
    changes.forEach((c, i) => {
        const id = i ? `${item.id}#${i}` : item.id
        const path = String(c?.path ?? '')
        const diff = String(c?.diff ?? '')
        switch (c?.kind?.type) {
            case 'add':
                calls.push(call(id, 'write', { path, content: diff }))
                break
            case 'delete':
                calls.push(call(id, 'delete', { path }))
                break
            default: {
                const to = c?.kind?.move_path
                calls.push(call(id, 'edit', { path: to || path, ...(to ? { from: path } : {}), edits: hunkEdits(diff) }))
                details[id] = { patch: diff }
            }
        }
    })
    if (!calls.length)
        calls.push(call(item.id, 'edit', { path: '' }))
    return { calls, details }
}

const STATUS: Record<string, string> = { inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'failed' }

/** A thread item that is a tool call, as an ACP tool_call update; undefined for the rest. */
/** Subagents' names by thread id, for the calls that address them. */
type AgentNames = ReadonlyMap<string, string>

/** What a collab call (other than spawning) does, in a line: "Wait for Kant", "Message Kant". */
function collabLine(item: any, names?: AgentNames): string {
    const ids: string[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    const who = ids.map(id => names?.get(id) ?? tr('子 Agent', 'subagent')).join(', ') || tr('子 Agent', 'subagents')
    switch (item.tool) {
        case 'wait':
            return tr(`等待 ${who}`, `Wait for ${who}`)
        case 'sendInput':
        case 'sendMessage':
        case 'followupTask':
            return tr(`发给 ${who}`, `Message ${who}`)
        case 'resumeAgent':
            return tr(`恢复 ${who}`, `Resume ${who}`)
        case 'closeAgent':
            return tr(`关闭 ${who}`, `Close ${who}`)
        case 'interruptAgent':
            return tr(`打断 ${who}`, `Interrupt ${who}`)
        case 'listAgents':
            return tr('列出子 Agent', 'List subagents')
        default:
            return String(item.tool ?? '')
    }
}

function itemUpdate(item: any, names?: AgentNames): Record<string, any> | undefined {
    const id = String(item?.id ?? '')
    const status = STATUS[item?.status] ?? (item?.status === undefined ? undefined : 'failed')
    switch (item?.type) {
        case 'commandExecution': {
            const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : item.status === 'declined' ? tr('用户拒绝了这条命令', 'The user declined this command') : ''
            return {
                toolCallId: id,
                kind: 'execute',
                status,
                rawInput: { command: displayCommand(String(item.command ?? '')) },
                ...(typeof item.exitCode === 'number' ? { rawOutput: { exitCode: item.exitCode } } : {}),
                ...(output ? { content: textBlock(output) } : {}),
                _meta: { piCalls: [commandCall(item)] },
            }
        }
        case 'fileChange': {
            const { calls, details } = fileChangeCalls(item)
            const declined = item.status === 'declined'
            return {
                toolCallId: id,
                kind: 'edit',
                status,
                ...(declined ? { content: textBlock(tr('用户拒绝了这次修改', 'The user declined this change')) } : {}),
                _meta: { piCalls: calls, piDetails: declined ? {} : details },
            }
        }
        case 'mcpToolCall': {
            const text = (item.result?.content ?? []).map((c: any) => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
            const failed = !!item.error
            return {
                toolCallId: id,
                status: failed ? 'failed' : status,
                content: textBlock(failed ? String(item.error?.message ?? 'MCP error') : text),
                _meta: { piCalls: [call(id, `${item.server}.${item.tool}`, item.arguments && typeof item.arguments === 'object' ? item.arguments : {})] },
            }
        }
        case 'dynamicToolCall': {
            const text = (item.contentItems ?? []).map((c: any) => c?.text ?? '').filter(Boolean).join('\n')
            return {
                toolCallId: id,
                status: item.success === false ? 'failed' : status,
                ...(text ? { content: textBlock(text) } : {}),
                _meta: { piCalls: [call(id, String(item.tool ?? 'tool'), item.arguments && typeof item.arguments === 'object' ? item.arguments : {})] },
            }
        }
        case 'webSearch':
            return {
                toolCallId: id,
                status: 'completed',
                content: textBlock((item.results ?? []).map((r: any) => r?.url).filter(Boolean).join('\n')),
                _meta: { piCalls: [call(id, 'web_search', { query: String(item.query ?? '') })] },
            }
        case 'imageView':
            return { toolCallId: id, status: 'completed', _meta: { piCalls: [call(id, 'read', { path: String(item.path ?? '') })] } }
        case 'collabAgentToolCall': {
            // A spawned subagent is a subagent call; the adapter fills in its thread (see Subagent).
            if (item.tool === 'spawnAgent')
                return { toolCallId: id, status, _meta: { piCalls: [call(id, 'subagent', { task: String(item.prompt ?? '') })] } }
            const states = Object.values(item.agentsStates ?? {}) as any[]
            const text = states.map(s => s?.message).filter(Boolean).join('\n\n')
            const failed = states.some(s => s?.status === 'errored')
            return {
                toolCallId: id,
                status: failed ? 'failed' : status,
                ...(text ? { content: textBlock(text) } : {}),
                _meta: { piCalls: [call(id, 'agent', { description: collabLine(item, names), ...(item.prompt ? { task: item.prompt } : {}) })] },
            }
        }
        default:
            return undefined
    }
}

const askQuestionsOf = (raw: unknown): AskQuestion[] => (Array.isArray(raw) ? raw : [])
    .filter((q: any) => typeof q?.id === 'string' && typeof q.question === 'string')
    .map((q: any) => ({ id: q.id, question: q.question, options: (q.options ?? []).map((o: any) => String(o?.label ?? '')).filter(Boolean) }))

/** Codex keys answers by question id, each a list of strings: the picked labels, then typed text. */
function codexAnswers(questions: AskQuestion[], response: AskResponse): { codex: Record<string, { answers: string[] }>, shown: Record<string, AskAnswer> } {
    const codex: Record<string, { answers: string[] }> = {}
    const shown: Record<string, AskAnswer> = {}
    if ('answers' in response) {
        for (const q of questions) {
            const answer = response.answers[q.id]
            const text = answer?.text?.trim()
            const answers = [...(answer?.selected ?? []), ...(text ? [text] : [])]
            if (!answers.length)
                continue
            codex[q.id] = { answers }
            shown[q.id] = text ? { selected: answer!.selected, text } : { selected: answer!.selected }
        }
    }
    return { codex, shown }
}

const inputOf = (message: string, images: ImageContent[]) => [
    ...(message ? [{ type: 'text', text: message, text_elements: [] }] : []),
    ...images.map(i => ({ type: 'image', url: `data:${i.mimeType};base64,${i.data}` })),
]

/** Token counts Codex reports (TokenUsageBreakdown). */
interface Tokens {
    inputTokens: number
    cachedInputTokens: number
    cacheWriteInputTokens?: number
    outputTokens: number
    reasoningOutputTokens: number
    totalTokens: number
}

const usageBetween = (from: Tokens | null, to: Tokens): PromptUsage => {
    const d = (k: keyof Tokens) => (to[k] ?? 0) - (from?.[k] ?? 0)
    return { inputTokens: d('inputTokens'), cachedReadTokens: d('cachedInputTokens'), cachedWriteTokens: d('cacheWriteInputTokens'), outputTokens: d('outputTokens'), thoughtTokens: d('reasoningOutputTokens'), totalTokens: d('totalTokens') }
}

interface ModelInfo {
    id: string
    name: string
    efforts: { value: string, description?: string }[]
    defaultEffort?: string
    images: boolean
}

/** The answer to send back for each choice; cancel when the prompt goes away unanswered. */
type ApprovalReply = (choice: ApprovalChoice | 'cancel') => unknown

interface ApprovalWait {
    resolve: (result: unknown) => void
    reply: ApprovalReply
}

/** An MCP elicitation form's field, kept to turn the typed answer back into its JSON type. */
interface ElicitField {
    key: string
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
    /** Shown label → the value sent, for choices. */
    values?: Map<string, string>
}

interface ElicitWait {
    resolve: (result: unknown) => void
    questions: AskQuestion[]
    fields: ElicitField[]
    /** The thread's or a subagent's: where the form is shown. */
    transcript: AcpTranscript
}

/**
 * An MCP form (requestedSchema: flat properties of string, number, boolean, enum, multi-select) →
 * questions for the ask form. Choices become options, the rest is typed.
 */
export function elicitForm(message: string, schema: any): { questions: AskQuestion[], fields: ElicitField[] } {
    const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : [])
    // Required fields first (Codex passes the properties on sorted by name).
    const properties = (schema?.properties && typeof schema.properties === 'object' ? Object.entries<any>(schema.properties) : [])
        .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)))
    const questions: AskQuestion[] = []
    const fields: ElicitField[] = []
    properties.forEach(([key, p], i) => {
        const multiple = p?.type === 'array'
        const enumOf = multiple ? p.items : p
        const titled = enumOf?.oneOf ?? enumOf?.anyOf
        const options: [string, string][] = Array.isArray(titled)
            ? titled.map((o: any) => [String(o?.title ?? o?.const), String(o?.const)])
            : Array.isArray(enumOf?.enum)
                ? enumOf.enum.map((v: any, j: number) => [String(p.enumNames?.[j] ?? v), String(v)])
                : p?.type === 'boolean' ? [[tr('是', 'Yes'), 'true'], [tr('否', 'No'), 'false']] : []
        const label = String(p?.title ?? key) + (p?.description ? ` (${p.description})` : '') + (required.has(key) ? '' : tr('（可选）', ' (optional)'))
        questions.push({ id: key, question: i === 0 && message ? `${message} · ${label}` : label, options: options.map(o => o[0]), ...(multiple ? { multiple: true } : {}) })
        fields.push({ key, type: ['number', 'integer', 'boolean', 'array'].includes(p?.type) ? p.type : 'string', ...(options.length ? { values: new Map(options) } : {}) })
    })
    return { questions, fields }
}

/** The ask form's answers → the form's content, typed as the schema says; undefined if a number is not one. */
export function elicitContent(fields: ElicitField[], answers: Record<string, AskAnswer>): Record<string, unknown> | undefined {
    const content: Record<string, unknown> = {}
    for (const field of fields) {
        const answer = answers[field.key]
        if (!answer)
            continue
        const picked = answer.selected.map(label => field.values?.get(label) ?? label)
        const typed = answer.text?.trim()
        const values = [...picked, ...(typed ? [typed] : [])]
        if (!values.length)
            continue
        if (field.type === 'array') {
            content[field.key] = values
        }
        else if (field.type === 'boolean') {
            content[field.key] = /^(true|yes|y|是|1)$/i.test(values[0])
        }
        else if (field.type === 'number' || field.type === 'integer') {
            const n = Number(values[0])
            if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n)))
                return undefined
            content[field.key] = n
        }
        else {
            content[field.key] = values[0]
        }
    }
    return content
}

/** A permission profile Codex asks for, in lines: "Network access", "Write /tmp/x". */
function permissionLines(permissions: any): string[] {
    const lines: string[] = []
    if (permissions?.network?.enabled)
        lines.push(tr('联网', 'Network access'))
    const fs = permissions?.fileSystem
    const entries: any[] = Array.isArray(fs?.entries) ? fs.entries : []
    const where = (p: any) => (p?.type === 'path' ? String(p.path) : p?.type === 'glob_pattern' ? String(p.pattern) : p?.type === 'special' ? String(p.value?.kind ?? '') : '')
    const verb = (access: string) => (access === 'write' ? tr('写', 'Write') : access === 'deny' ? tr('禁止', 'Deny') : tr('读', 'Read'))
    if (entries.length) {
        for (const e of entries)
            lines.push(`${verb(e.access)} ${where(e.path)}`)
    }
    else {
        for (const path of fs?.read ?? [])
            lines.push(`${verb('read')} ${path}`)
        for (const path of fs?.write ?? [])
            lines.push(`${verb('write')} ${path}`)
    }
    return lines
}

interface AskWait {
    resolve: (result: unknown) => void
    questions: AskQuestion[]
}

/** A proposed plan the user reviews; the turn that wrote it has ended, its run has not. */
interface PlanWait {
    id: string
    plan: string
    usage?: PromptUsage
}

/**
 * A subagent Codex spawned (multi_agent spawn_agent): a thread of its own on this connection. The
 * parent's spawn call stays open while it works and shows its transcript (the subagent capability's
 * view), until its turn ends or the parent's does.
 */
interface Subagent {
    threadId: string
    /** The parent's spawnAgent item: the subagent call. */
    callId: string
    title: string
    task: string
    model?: string
    transcript: AcpTranscript
    streamed: Set<string>
    tools: SubagentDetails['tools']
    status: SubagentDetails['status']
    turnId: string | null
    tokens: Tokens | null
    startedAt: number
    endedAt?: number
    error?: string
    /** The parent's call has its result: later events are not shown live. */
    closed: boolean
    /** Settles once its nickname was asked for. */
    named: Promise<void>
    flush?: ReturnType<typeof setTimeout>
}

const SUBAGENT_STATUS: Record<string, SubagentDetails['status']> = { completed: 'done', failed: 'failed', interrupted: 'cancelled' }

function subagentUsage(tokens: Tokens | null): SubagentDetails['usage'] {
    const input = tokens?.inputTokens ?? 0
    const cached = tokens?.cachedInputTokens ?? 0
    return { input: Math.max(0, input - cached), output: tokens?.outputTokens ?? 0, cacheRead: cached, cacheWrite: tokens?.cacheWriteInputTokens ?? 0, cost: 0 }
}

/** What the subagent said last: the call's result text for the parent's transcript. */
function lastText(messages: readonly AgentMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'assistant') {
            const text = m.content.filter(c => c.type === 'text').map(c => (c as any).text).join('')
            if (text)
                return text
        }
    }
    return ''
}

/** A streaming item's deltas, the same for a thread and its subagents. */
function streamDelta(transcript: AcpTranscript, streamed: Set<string>, method: string, params: any) {
    switch (method) {
        case 'item/agentMessage/delta':
            streamed.add(params?.itemId)
            transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(params?.delta ?? '') } })
            break
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
            streamed.add(params?.itemId)
            transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: String(params?.delta ?? '') } })
            break
        case 'item/reasoning/summaryPartAdded':
            if (streamed.has(params?.itemId))
                transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '\n\n' } })
            break
        case 'item/commandExecution/outputDelta':
        case 'item/fileChange/outputDelta':
            transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: params?.itemId, _meta: { terminal_output_delta: { data: String(params?.delta ?? '') } } })
            break
        default:
            break
    }
}

function startItem(transcript: AcpTranscript, item: any, names?: AgentNames, sessionUpdate = 'tool_call') {
    const update = itemUpdate(item, names)
    if (update)
        transcript.update({ sessionUpdate, ...update, status: 'in_progress' })
}

/** item/completed: text that did not stream comes whole; a call gets its result. */
function completeItem(transcript: AcpTranscript, streamed: Set<string>, item: any, names?: AgentNames) {
    switch (item.type) {
        case 'userMessage':
            return
        case 'agentMessage':
            if (!streamed.has(item.id) && item.text)
                transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: item.text } })
            return
        case 'reasoning':
            if (!streamed.has(item.id)) {
                for (const part of (item.content?.length ? item.content : item.summary ?? []) as string[])
                    transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part } })
            }
            return
        case 'contextCompaction':
            transcript.compaction('', 0)
            return
    }
    const update = itemUpdate(item, names)
    if (update)
        transcript.update({ sessionUpdate: 'tool_call_update', ...update })
}

/** Other threads' events kept until a spawn call names their thread (they can come first). */
const STRAYS_KEPT = 200

// ---------------------------------------------------------------- adapter

/** One `codex app-server` process bound to one thread (Codex's word for a session). */
export class CodexAgent implements AgentAdapter {
    readonly id = randomUUID()
    readonly ready: Promise<void>
    readonly caps = CODEX_CAPS
    private child: ChildProcessWithoutNullStreams
    private connection: AcpConnection
    private stderr = ''
    private exited = false
    private transcript: AcpTranscript
    private threadId = ''
    /** Replaying the thread's history: no events, the session's own time on messages. */
    private loading = true
    /** Opened while another process writes the thread: read, not resumed (see takeOver). */
    private detached = false
    /** The user picked a mode here: it wins over the one the thread resumes with. */
    private modeChosen = false

    private models: ModelInfo[] = []
    private model = ''
    private effort = ''
    private mode: ModeId = 'auto'
    /** The mode before plan mode, which an accepted plan goes back to. */
    private workMode: ModeId = 'auto'
    private context: { used: number, size: number } | null = null
    private tokens: Tokens | null = null
    private turnBase: Tokens | null = null

    /** A run: from the prompt until no turn, follow-up or plan review is left (agent_start … agent_end). */
    private running = false
    /** The turn in flight: its id once turn/start answered (or turn/started came). */
    private turnId: string | null = null
    private turnStarting = false
    private abortWanted = false
    private turnError = ''
    /** Items whose text streamed in deltas (the rest arrive whole on item/completed). */
    private streamed = new Set<string>()
    private planItem: { id: string, text: string } | null = null
    private queued: { message: string, images: ImageContent[] }[] = []
    /** The transcript position of each turn's prompt → the turn's id, for asking again and forking. */
    private turnAt = new Map<number, string>()

    /** Subagents by their thread id. */
    private subagents = new Map<string, Subagent>()
    private strays: [string, any][] = []
    private agentNames = new Map<string, string>()
    /** Running collab calls (wait_agent, send_input, …), renamed once their subagent's name is known. */
    private collabOpen = new Map<string, any>()

    private approvals = new Map<string, ApprovalWait>()
    private asks = new Map<string, AskWait>()
    private elicits = new Map<string, ElicitWait>()
    private planWait: PlanWait | null = null

    constructor(readonly spec: AcpAgentSpec, launch: CodexLaunch, private options: AgentAdapterOptions, private callbacks: AgentAdapterCallbacks) {
        this.threadId = options.sessionId ?? ''
        this.transcript = new AcpTranscript('', {
            model: () => ({ provider: spec.label, model: this.model || undefined, thinkingLevel: this.effort || undefined }),
            inputIncludesCache: true,
            now: () => (this.loading ? options.replayTime ?? Date.now() : Date.now()),
        })
        this.child = spawn(launch.file, launch.args, { cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: launch.windowsVerbatimArguments })
        this.connection = new AcpConnection(this.child.stdin, this.child.stdout, {
            onNotification: (method, params) => this.notification(method, params),
            onRequest: (method, params) => this.serverRequest(method, params),
        })
        this.child.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT)
        })
        const finish = (code: number | null, signal: string | null) => {
            if (this.exited)
                return
            this.exited = true
            this.connection.close(new Error(this.lastError() || tr(`${spec.label} 已退出（${code ?? signal}）`, `${spec.label} exited (${code ?? signal})`)))
            this.cancelWaits()
            callbacks.onExit(this.id, { code, signal, stderr: this.stderr })
        }
        this.child.on('exit', finish)
        this.child.on('error', (error) => {
            this.stderr += `\n${error.message}`
            finish(null, null)
        })
        this.ready = this.open()
        // A failed start ends the process; the exit carries the reason to the thread.
        this.ready.catch((error) => {
            this.stderr += `\n${error?.message ?? error}`
            this.child.kill('SIGTERM')
        })
    }

    get key(): string {
        return this.threadId ? acpSessionKey(this.spec.id, this.threadId) : ''
    }

    get cwd(): string {
        return this.options.cwd
    }

    get sessionId(): string {
        return this.threadId
    }

    snapshot(): SessionItem[] {
        return this.transcript.snapshot()
    }

    private lastError(): string {
        return this.stderr.trim().split('\n').slice(-5).join('\n')
    }

    private emit(event: PiEvent) {
        if (!this.options.readOnly && !this.loading)
            this.callbacks.onEvent(this.id, event)
    }

    private rpc<T = any>(method: string, params: unknown): Promise<T> {
        return this.connection.request<T>(method, params)
    }

    /** Sign-in failures read as what to do about them. */
    private explain(error: any): string {
        const message = String(error?.message ?? error)
        if (ACTIVE_WRITER.test(message))
            return tr(`这个线程正在别处打开着（Codex 终端、VS Code 或另一个标签页），关掉那边再试。（${message}）`, `This thread is open elsewhere (the Codex TUI, VS Code or another tab); close it there and try again. (${message})`)
        if (/\b401\b|unauthori[sz]ed|not (signed|logged) in|login|api key/i.test(message))
            return tr(`${this.spec.label} 还没有登录：${this.spec.signIn.zh}。（${message}）`, `${this.spec.label} is not signed in: ${this.spec.signIn.en}. (${message})`)
        return message
    }

    private async open() {
        await this.rpc('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } })
        this.connection.notify('initialized', undefined)
        let info: any
        if (this.options.sessionId && this.options.readOnly) {
            // Reading only: Codex lets one process write a thread, and another (a tab, the Codex
            // TUI) may have it open; thread/read and thread/turns/list do not take it over.
            info = await this.rpc('thread/read', { threadId: this.options.sessionId })
            await this.loadHistory()
        }
        else if (this.options.sessionId) {
            // The turns come from thread/turns/list, page by page. Another process writing the thread
            // (the tab forked from, the Codex TUI) leaves this one reading it until it is free:
            // forking works meanwhile, a prompt takes the thread over then (takeOver).
            info = await this.rpc('thread/resume', { threadId: this.options.sessionId, excludeTurns: true }).catch(async (error) => {
                if (!ACTIVE_WRITER.test(String(error?.message ?? error)))
                    throw new Error(this.explain(error))
                this.detached = true
                const read: any = await this.rpc('thread/read', { threadId: this.options.sessionId })
                return { ...read, model: read?.thread?.model, reasoningEffort: read?.thread?.reasoningEffort }
            })
            await this.loadHistory()
        }
        else {
            info = await this.rpc('thread/start', { cwd: this.options.cwd })
            this.threadId = String(info?.thread?.id ?? '')
            if (!this.threadId)
                throw new Error(tr(`${this.spec.label} 没有返回线程`, `${this.spec.label} returned no thread`))
        }
        this.model = String(info?.model ?? '')
        this.effort = String(info?.reasoningEffort ?? '')
        this.mode = modeOf(info?.sandbox, info?.collaborationMode)
        if (this.mode !== 'plan')
            this.workMode = this.mode
        this.transcript.finish('end_turn')
        this.loading = false
        if (this.options.readOnly)
            return
        await this.loadModels().catch(error => console.warn(`[codex] model/list failed:`, error?.message ?? error))
        this.transcript.setEmitter(event => this.emit(event))
        this.callbacks.onSession?.(this, info?.thread?.name ? { title: info.thread.name } : {})
    }

    /** Before writing: a thread opened while another process wrote it is resumed now. */
    private async takeOver() {
        if (!this.detached)
            return
        const info: any = await this.rpc('thread/resume', { threadId: this.threadId, excludeTurns: true }).catch((error) => {
            throw new Error(this.explain(error))
        })
        this.detached = false
        if (!this.modeChosen) {
            this.mode = modeOf(info?.sandbox, info?.collaborationMode)
            if (this.mode !== 'plan')
                this.workMode = this.mode
            this.configChanged()
        }
    }

    private async loadModels() {
        const models: ModelInfo[] = []
        let cursor: string | undefined
        for (let page = 0; page < 5; page++) {
            const result: any = await this.rpc('model/list', cursor ? { cursor } : {})
            for (const m of result?.data ?? []) {
                if (typeof m?.id !== 'string' || m.hidden)
                    continue
                models.push({
                    id: m.model ?? m.id,
                    name: String(m.displayName ?? m.id),
                    efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => ({ value: String(e.reasoningEffort), description: e.description })),
                    defaultEffort: m.defaultReasoningEffort,
                    images: !Array.isArray(m.inputModalities) || m.inputModalities.includes('image'),
                })
            }
            cursor = result?.nextCursor || undefined
            if (!cursor)
                break
        }
        this.models = models
        if (!this.effort)
            this.effort = this.currentModel()?.defaultEffort ?? ''
    }

    private currentModel(): ModelInfo | undefined {
        return this.models.find(m => m.id === this.model)
    }

    /** Model, reasoning effort and mode as the composer's selects. */
    private configOptions(): AcpConfigOption[] {
        const options: AcpConfigOption[] = []
        const models = this.models.some(m => m.id === this.model) || !this.model ? this.models : [{ id: this.model, name: this.model, efforts: [], images: true }, ...this.models]
        if (models.length)
            options.push({ id: 'model', name: tr('模型', 'Model'), category: 'model', currentValue: this.model, options: models.map(m => ({ value: m.id, name: m.name })) })
        const efforts = this.currentModel()?.efforts ?? []
        if (efforts.length)
            options.push({ id: 'reasoning_effort', name: tr('思考强度', 'Reasoning'), category: 'thought_level', currentValue: this.effort, options: efforts.map(e => ({ value: e.value, name: e.value, description: e.description })) })
        options.push(modeOption(this.mode))
        return options
    }

    private configChanged() {
        this.emit({ type: 'acp_config_changed', configOptions: this.configOptions() })
    }

    private setConfig(configId: string, value: string) {
        if (configId === 'model') {
            if (!this.models.some(m => m.id === value))
                throw new Error(tr(`没有这个模型：${value}`, `No such model: ${value}`))
            this.model = value
            const model = this.currentModel()
            if (model && !model.efforts.some(e => e.value === this.effort))
                this.effort = model.defaultEffort ?? model.efforts[0]?.value ?? ''
        }
        else if (configId === 'reasoning_effort') {
            if (!(this.currentModel()?.efforts ?? []).some(e => e.value === value))
                throw new Error(tr(`这个模型没有 ${value} 思考强度`, `This model has no ${value} reasoning effort`))
            this.effort = value
        }
        else if (configId === 'mode') {
            if (!(value in MODES))
                throw new Error(tr(`没有这个模式：${value}`, `No such mode: ${value}`))
            this.mode = value as ModeId
            this.modeChosen = true
            if (this.mode !== 'plan')
                this.workMode = this.mode
        }
        else {
            throw new Error(tr('没有这个选项', 'No such option'))
        }
        // Taken up by the next turn (turn/start carries them).
        this.configChanged()
    }

    /** The settings every turn carries: Codex applies them to it and the turns after. */
    private turnSettings() {
        const mode = MODES[this.mode]
        return {
            approvalPolicy: mode.approvalPolicy,
            sandboxPolicy: mode.sandboxPolicy,
            ...(this.model ? { model: this.model } : {}),
            ...(this.effort ? { effort: this.effort } : {}),
            ...(this.model
                ? { collaborationMode: { mode: this.mode === 'plan' ? 'plan' : 'default', settings: { model: this.model, reasoning_effort: this.effort || null, developer_instructions: null } } }
                : {}),
        }
    }

    // ---------------------------------------------------------------- history

    /** A thread's turns, oldest first, every item. A failure throws: an empty thread would look like a session with no history. */
    private async turnsOf(threadId: string): Promise<any[]> {
        const turns: any[] = []
        let cursor: string | null | undefined
        do {
            const page: any = await this.rpc('thread/turns/list', { threadId, sortDirection: 'asc', itemsView: 'full', cursor })
            turns.push(...(page?.data ?? []))
            cursor = page?.nextCursor
        } while (cursor)
        return turns
    }

    /** The thread's history, page by page (codex 0.160: `asc`, `data`, `nextCursor`), its subagents' with it. */
    private async loadHistory() {
        const turns = await this.turnsOf(this.threadId)
        const subagents = await this.historySubagents(turns)
        turns.forEach((turn, i) => {
            let prompted = false
            for (const item of turn.items ?? []) {
                if (item?.type === 'userMessage' && !prompted) {
                    prompted = true
                    this.historyItem(item, this.transcript)
                    if (turn.id)
                        this.turnAt.set(this.transcript.messages.length - 1, turn.id)
                    continue
                }
                if (item?.type === 'plan')
                    this.historyPlan(item, turns[i + 1])
                else
                    this.historyItem(item, this.transcript, subagents)
            }
            this.transcript.finish(turn.status === 'interrupted' ? 'cancelled' : 'end_turn', undefined, turn.status === 'failed' ? String(turn.error?.message ?? 'Failed') : undefined)
        })
    }

    /** Each spawned subagent's thread read back, as its call's details (by the spawn item's id). */
    private async historySubagents(turns: any[]): Promise<Map<string, SubagentDetails>> {
        const spawns = turns.flatMap(t => t.items ?? []).filter((i: any) => i?.type === 'collabAgentToolCall' && i.tool === 'spawnAgent' && i.receiverThreadIds?.[0])
        const found = new Map<string, SubagentDetails>()
        await Promise.all(spawns.map(async (item: any) => {
            const threadId = String(item.receiverThreadIds[0])
            try {
                const [childTurns, read] = await Promise.all([this.turnsOf(threadId), this.rpc('thread/read', { threadId }).catch(() => null)])
                const transcript = this.subagentTranscript(String(item.model ?? ''), String(item.reasoningEffort ?? ''))
                for (const turn of childTurns) {
                    for (const child of turn.items ?? [])
                        this.historyItem(child, transcript)
                    transcript.finish(turn.status === 'interrupted' ? 'cancelled' : 'end_turn', undefined, turn.status === 'failed' ? String(turn.error?.message ?? 'Failed') : undefined)
                }
                const last = childTurns[childTurns.length - 1]
                if (read?.thread?.agentNickname)
                    this.agentNames.set(threadId, String(read.thread.agentNickname))
                const seconds = (t: unknown) => (typeof t === 'number' ? t * 1000 : undefined)
                found.set(String(item.id), {
                    kind: 'subagent',
                    status: last?.status === 'inProgress' ? 'running' : SUBAGENT_STATUS[last?.status] ?? 'done',
                    title: String(read?.thread?.agentNickname ?? '') || tr('子 Agent', 'Subagent'),
                    task: String(item.prompt ?? ''),
                    model: item.model || undefined,
                    messages: transcript.messages.map(m => m.message),
                    tools: {},
                    steering: [],
                    usage: subagentUsage(null),
                    startedAt: seconds(childTurns[0]?.startedAt) ?? this.options.replayTime ?? 0,
                    endedAt: seconds(last?.completedAt),
                    ...(last?.status === 'failed' ? { error: String(last.error?.message ?? 'Failed') } : {}),
                })
            }
            catch (error: any) {
                console.warn(`[codex] subagent ${threadId} unreadable:`, error?.message ?? error)
            }
        }))
        return found
    }

    private historyItem(item: any, transcript: AcpTranscript, subagents?: Map<string, SubagentDetails>) {
        switch (item?.type) {
            case 'userMessage':
                for (const input of item.content ?? []) {
                    if (input?.type === 'text' && typeof input.text === 'string')
                        transcript.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: input.text } })
                    else if (input?.type === 'image' && typeof input.url === 'string') {
                        const m = /^data:([^;]+);base64,(.*)$/s.exec(input.url)
                        if (m)
                            transcript.update({ sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: m[1], data: m[2] } })
                    }
                }
                break
            case 'agentMessage':
                transcript.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: item.text ?? '' } })
                break
            case 'reasoning': {
                // The raw reasoning when Codex kept it, else its summary.
                const parts: string[] = item.content?.length ? item.content : item.summary ?? []
                for (const part of parts)
                    transcript.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part } })
                break
            }
            case 'contextCompaction':
                transcript.compaction('', 0)
                break
            default: {
                const update = itemUpdate(item, this.agentNames)
                if (!update)
                    break
                const details = subagents?.get(String(item.id))
                if (details) {
                    const text = lastText(details.messages)
                    update._meta = { ...update._meta, piDetails: { [item.id]: details } }
                    if (text)
                        update.content = textBlock(text)
                    if (details.status === 'failed')
                        update.status = 'failed'
                }
                transcript.update({ sessionUpdate: 'tool_call', ...update, status: update.status === 'in_progress' ? 'failed' : update.status })
            }
        }
    }

    /** A plan read back: what the next turn did with it (accepted it, asked for changes) is its outcome. */
    private historyPlan(item: any, next: any) {
        const plan = String(item.text ?? '')
        const reply = (next?.items ?? []).find((i: any) => i?.type === 'userMessage')
        const text = (reply?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
        const details = !reply
            ? { kind: 'plan', status: 'cancelled', plan }
            : text.trim() === IMPLEMENT_PLAN ? { kind: 'plan', status: 'approved', plan } : { kind: 'plan', status: 'revised', plan, feedback: text }
        this.transcript.update({ sessionUpdate: 'tool_call', toolCallId: item.id, status: 'completed', _meta: { piCalls: [call(item.id, 'propose_plan', { plan })], piDetails: { [item.id]: details } } })
    }

    // ---------------------------------------------------------------- server → client

    private notification(method: string, params: any) {
        // Subagents run as threads of their own on this connection; other threads' events are not this one's.
        if (params?.threadId && this.threadId && params.threadId !== this.threadId) {
            if (this.loading)
                return
            const sub = this.subagents.get(params.threadId)
            if (sub) {
                this.subagentNotification(sub, method, params)
            }
            else {
                this.strays.push([method, params])
                this.strays.splice(0, this.strays.length - STRAYS_KEPT)
            }
            return
        }
        if (this.loading)
            return
        switch (method) {
            case 'turn/started':
                this.turnId ??= String(params?.turn?.id ?? '') || null
                break
            case 'turn/completed':
                this.turnCompleted(params?.turn)
                break
            case 'error':
                if (!params?.willRetry)
                    this.turnError = String(params?.error?.message ?? '')
                break
            case 'thread/tokenUsage/updated': {
                const usage = params?.tokenUsage
                if (usage?.total)
                    this.tokens = usage.total
                const size = usage?.modelContextWindow
                if (usage?.last && typeof size === 'number' && size > 0)
                    this.context = { used: usage.last.totalTokens ?? 0, size }
                break
            }
            case 'thread/name/updated':
                if (typeof params?.threadName === 'string' && params.threadName)
                    this.callbacks.onSession?.(this, { title: params.threadName })
                break
            case 'turn/plan/updated':
                this.transcript.update({
                    sessionUpdate: 'plan',
                    entries: (params?.plan ?? []).map((s: any) => ({ content: String(s?.step ?? ''), status: s?.status === 'inProgress' ? 'in_progress' : s?.status })),
                })
                break
            case 'item/started':
                this.itemStarted(params?.item)
                break
            case 'item/completed':
                this.itemCompleted(params?.item)
                break
            case 'item/plan/delta':
                if (this.planItem && this.planItem.id === params?.itemId) {
                    this.planItem.text += String(params?.delta ?? '')
                    this.showPlan()
                }
                break
            default:
                streamDelta(this.transcript, this.streamed, method, params)
                break
        }
    }

    private itemStarted(item: any) {
        if (!item?.id)
            return
        if (item.type === 'plan') {
            this.planItem = { id: item.id, text: String(item.text ?? '') }
            this.transcript.update({ sessionUpdate: 'tool_call', toolCallId: item.id, status: 'in_progress', _meta: { piCalls: [call(item.id, 'propose_plan', { plan: this.planItem.text })] } })
            return
        }
        if (item.type === 'collabAgentToolCall' && item.tool !== 'spawnAgent')
            this.collabOpen.set(item.id, item)
        startItem(this.transcript, item, this.agentNames)
    }

    private itemCompleted(item: any) {
        if (!item?.id)
            return
        switch (item.type) {
            case 'userMessage':
                // Shown when it was sent (prompt, steer).
                return
            case 'plan':
                // Stays open: the user reviews it once the turn ends.
                if (this.planItem && this.planItem.id === item.id) {
                    this.planItem.text = String(item.text ?? this.planItem.text)
                    this.showPlan()
                }
                return
            case 'collabAgentToolCall':
                this.collabOpen.delete(item.id)
                // Spawned: the call stays open while the subagent works.
                if (item.tool === 'spawnAgent' && item.status === 'completed' && item.receiverThreadIds?.[0]) {
                    this.adoptSubagent(item)
                    return
                }
                break
        }
        completeItem(this.transcript, this.streamed, item, this.agentNames)
    }

    // ---------------------------------------------------------------- subagents

    private subagentTranscript(model: string, effort: string): AcpTranscript {
        return new AcpTranscript('sub:', {
            model: () => ({ provider: this.spec.label, model: model || this.model || undefined, thinkingLevel: effort || undefined }),
            inputIncludesCache: true,
            now: () => (this.loading ? this.options.replayTime ?? Date.now() : Date.now()),
        })
    }

    /** spawn_agent made a thread: its events fill the spawn call from now on. */
    private adoptSubagent(item: any) {
        const threadId = String(item.receiverThreadIds[0])
        if (this.subagents.has(threadId))
            return
        const sub: Subagent = {
            threadId,
            callId: String(item.id),
            title: tr('子 Agent', 'Subagent'),
            task: String(item.prompt ?? ''),
            model: item.model || undefined,
            transcript: this.subagentTranscript(String(item.model ?? ''), String(item.reasoningEffort ?? '')),
            streamed: new Set(),
            tools: {},
            status: 'running',
            turnId: null,
            tokens: null,
            startedAt: Date.now(),
            closed: false,
            named: Promise.resolve(),
        }
        sub.transcript.setEmitter(event => this.subagentEvent(sub, event))
        this.subagents.set(threadId, sub)
        // Its events from before the spawn call returned.
        const early = this.strays.filter(([, params]) => params?.threadId === threadId)
        this.strays = this.strays.filter(([, params]) => params?.threadId !== threadId)
        for (const [method, params] of early)
            this.subagentNotification(sub, method, params)
        this.flushSubagent(sub)
        // Codex names its subagents (Kant, …): the title the views show.
        sub.named = this.nameSubagent(sub)
    }

    /**
     * The subagent's nickname (thread/read). Its thread file is written as its turn starts, a few ms
     * after the spawn; until then the read fails, so it is tried again soon, then backing off (a
     * wait_agent shown before the name is in keeps "subagent").
     */
    private async nameSubagent(sub: Subagent, tries = 8): Promise<void> {
        for (let i = 0; i < tries && !this.exited; i++) {
            try {
                const read: any = await this.rpc('thread/read', { threadId: sub.threadId })
                const name = String(read?.thread?.agentNickname ?? '')
                if (name) {
                    sub.title = name
                    this.agentNames.set(sub.threadId, name)
                    // Calls already shown for it (wait_agent, …) get the name too.
                    for (const item of this.collabOpen.values()) {
                        if ((item.receiverThreadIds ?? []).includes(sub.threadId))
                            startItem(this.transcript, item, this.agentNames, 'tool_call_update')
                    }
                    this.flushSubagentSoon(sub)
                }
                return
            }
            catch {
                await new Promise(resolve => setTimeout(resolve, 25 * 2 ** i))
            }
        }
    }

    private subagentNotification(sub: Subagent, method: string, params: any) {
        switch (method) {
            case 'turn/started':
                sub.turnId = String(params?.turn?.id ?? '') || null
                sub.status = 'running'
                break
            case 'turn/completed': {
                const turn = params?.turn
                const status = String(turn?.status ?? '')
                const error = status === 'failed' ? String(turn?.error?.message || tr('子 Agent 失败了', 'The subagent failed')) : undefined
                sub.turnId = null
                sub.transcript.finish(status === 'interrupted' ? 'cancelled' : 'end_turn', undefined, error)
                // Its outcome now (the parent's turn may end first), its name when known.
                sub.status = SUBAGENT_STATUS[status] ?? 'done'
                sub.error = error
                if (!this.agentNames.has(sub.threadId))
                    sub.named = sub.named.then(() => (this.agentNames.has(sub.threadId) ? undefined : this.nameSubagent(sub, 1)))
                void sub.named.then(() => this.closeSubagent(sub, sub.status, sub.error))
                return
            }
            case 'thread/tokenUsage/updated':
                if (params?.tokenUsage?.total)
                    sub.tokens = params.tokenUsage.total
                break
            case 'item/started':
                if (params?.item?.id && params.item.type !== 'userMessage')
                    startItem(sub.transcript, params.item)
                break
            case 'item/completed':
                // Its task, and what the parent sends it later.
                if (params?.item?.type === 'userMessage')
                    this.historyItem(params.item, sub.transcript)
                else if (params?.item?.id)
                    completeItem(sub.transcript, sub.streamed, params.item)
                break
            default:
                streamDelta(sub.transcript, sub.streamed, method, params)
                break
        }
        this.flushSubagentSoon(sub)
    }

    /** The subagent transcript's own events: which of its calls run, for the views. */
    private subagentEvent(sub: Subagent, event: PiEvent) {
        if (event.type === 'tool_execution_start')
            sub.tools[event.toolCallId] = { startedAt: Date.now() }
        else if (event.type === 'tool_execution_update' && sub.tools[event.toolCallId])
            sub.tools[event.toolCallId].partial = event.partialResult
        else if (event.type === 'tool_execution_end')
            delete sub.tools[event.toolCallId]
    }

    private subagentDetails(sub: Subagent): SubagentDetails {
        return {
            kind: 'subagent',
            status: sub.status,
            title: sub.title,
            task: sub.task,
            model: sub.model,
            messages: sub.transcript.messages.map(m => m.message),
            streaming: sub.transcript.streaming ?? undefined,
            tools: { ...sub.tools },
            steering: [],
            usage: subagentUsage(sub.tokens),
            startedAt: sub.startedAt,
            endedAt: sub.endedAt,
            ...(sub.error ? { error: sub.error } : {}),
        }
    }

    private flushSubagent(sub: Subagent) {
        clearTimeout(sub.flush)
        sub.flush = undefined
        if (!sub.closed)
            this.transcript.setDetails(sub.callId, this.subagentDetails(sub))
    }

    /** Streaming deltas come fast: the view is sent at most every 50ms. */
    private flushSubagentSoon(sub: Subagent) {
        if (!sub.closed && !sub.flush)
            sub.flush = setTimeout(() => this.flushSubagent(sub), 50)
    }

    /** The spawn call gets its result: the subagent's transcript, its last words as the text. */
    private closeSubagent(sub: Subagent, status: SubagentDetails['status'], error?: string) {
        if (sub.closed)
            return
        clearTimeout(sub.flush)
        sub.flush = undefined
        sub.status = status
        sub.error = error
        sub.endedAt = Date.now()
        sub.closed = true
        const text = lastText(sub.transcript.messages.map(m => m.message))
        this.transcript.update({
            sessionUpdate: 'tool_call_update',
            toolCallId: sub.callId,
            status: status === 'failed' ? 'failed' : 'completed',
            ...(text || error ? { content: textBlock(text || error!) } : {}),
            _meta: { piDetails: { [sub.callId]: this.subagentDetails(sub) } },
        })
    }

    private subagentOf(callId: string): Subagent {
        const sub = [...this.subagents.values()].find(s => s.callId === callId)
        if (!sub || sub.closed || !sub.turnId)
            throw new Error(tr('这个子 Agent 已经不在运行', 'This subagent is no longer running'))
        return sub
    }

    private showPlan() {
        const item = this.planItem!
        this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: item.id, _meta: { piCalls: [call(item.id, 'propose_plan', { plan: item.text })] } })
    }

    private serverRequest(method: string, params: any): Promise<unknown> {
        if (params?.threadId && this.threadId && params.threadId !== this.threadId) {
            // A subagent's command or edit: asked like the thread's own, against the subagent's call.
            const sub = this.subagents.get(params.threadId)
            if (!sub || sub.closed)
                return Promise.reject(new RpcError(`Not this thread: ${params.threadId}`, -32602))
            if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
                this.flushSubagent(sub)
                return this.approval(params, method.includes('command') ? 'command' : 'file', sub.transcript)
            }
            if (method === 'item/permissions/requestApproval') {
                this.flushSubagent(sub)
                return this.permissions(params, sub.transcript)
            }
            if (method === 'mcpServer/elicitation/request') {
                this.flushSubagent(sub)
                return this.elicitation(params, sub.transcript)
            }
            if (method === 'item/tool/requestUserInput')
                return Promise.resolve({ answers: {} })
        }
        switch (method) {
            case 'item/commandExecution/requestApproval':
                return this.approval(params, 'command')
            case 'item/fileChange/requestApproval':
                return this.approval(params, 'file')
            case 'item/tool/requestUserInput':
                return this.ask(params)
            case 'item/permissions/requestApproval':
                return this.permissions(params)
            case 'mcpServer/elicitation/request':
                return this.elicitation(params)
            default:
                // Client-side tools, auth refresh: not something this app provides.
                return Promise.reject(new RpcError(`Method not found: ${method}`, -32601))
        }
    }

    /** A command or file change waiting on the user → the approval prompt. */
    private approval(params: any, kind: 'command' | 'file', transcript = this.transcript): Promise<unknown> {
        if (this.options.readOnly)
            return Promise.resolve({ decision: 'cancel' })
        const itemId = String(params?.itemId ?? '')
        const shown = transcript.callsOf(itemId)
        let always: unknown
        let alwaysLabel: string | undefined
        if (kind === 'command') {
            const decisions: any[] = Array.isArray(params?.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline']
            const amendment = decisions.find(d => d && typeof d === 'object' && d.acceptWithExecpolicyAmendment)
            if (decisions.includes('acceptForSession')) {
                always = 'acceptForSession'
                alwaysLabel = tr('本会话都允许', 'Allow for this session')
            }
            else if (amendment) {
                always = amendment
                const prefix = (amendment.acceptWithExecpolicyAmendment.execpolicy_amendment ?? []).join(' ')
                alwaysLabel = tr(`总是允许 ${prefix}`, `Always allow ${prefix}`)
            }
        }
        else {
            always = 'acceptForSession'
            alwaysLabel = tr('本会话都允许改这些文件', 'Allow these files for this session')
        }
        const summary = kind === 'command'
            ? displayCommand(String(params?.command ?? shown[0]?.arguments?.command ?? ''))
            : shown.map(c => String(c.arguments?.path ?? '')).filter(Boolean).join('\n') || String(params?.reason ?? '')
        const reason = typeof params?.reason === 'string' && params.reason && kind === 'command' ? `\n${params.reason}` : ''
        const approval: ApprovalRequest = {
            toolCallId: shown[0]?.id ?? itemId,
            tool: shown[0]?.name ?? (kind === 'command' ? 'bash' : 'edit'),
            summary: summary + reason,
            scope: always ? 'codex' : '',
            alwaysLabel,
        }
        return this.approvalPrompt(approval, (choice) => {
            const decision = choice === 'allow' ? 'accept' : choice === 'always' ? always ?? 'accept' : choice === 'deny' ? 'decline' : 'cancel'
            return { decision }
        })
    }

    /** Shows an approval prompt: allow, always (when it has a scope) and deny; `reply` turns the choice into the answer. */
    private approvalPrompt(approval: ApprovalRequest, reply: ApprovalReply): Promise<unknown> {
        const requestId = `codex-approval-${randomUUID()}`
        const choices: ApprovalChoice[] = approval.scope ? ['allow', 'always', 'deny'] : ['allow', 'deny']
        return new Promise((resolve) => {
            this.approvals.set(requestId, { resolve, reply })
            this.emit({ type: 'extension_ui_request', id: requestId, method: 'select', title: `${APPROVAL_TITLE_PREFIX}${JSON.stringify(approval)}`, options: choices })
        })
    }

    /** request_permissions: more filesystem or network access, for this turn or (always) the session. */
    private permissions(params: any, transcript = this.transcript): Promise<unknown> {
        const none = { permissions: {}, scope: 'turn' }
        if (this.options.readOnly)
            return Promise.resolve(none)
        const itemId = String(params?.itemId ?? '')
        const shown = transcript.callsOf(itemId)
        const lines = permissionLines(params?.permissions)
        const approval: ApprovalRequest = {
            toolCallId: shown[0]?.id ?? itemId,
            tool: shown[0]?.name ?? 'request_permissions',
            summary: [...lines, ...(params?.reason ? [String(params.reason)] : [])].join('\n') || tr('更多权限', 'More permissions'),
            scope: 'codex',
            alwaysLabel: tr('本会话都允许', 'Allow for this session'),
        }
        // Granted as asked: Codex takes a subset too, the prompt offers all or nothing.
        const asked = params?.permissions ?? {}
        const granted = { ...(asked.network ? { network: asked.network } : {}), ...(asked.fileSystem ? { fileSystem: asked.fileSystem } : {}) }
        return this.approvalPrompt(approval, choice => (choice === 'allow' ? { permissions: granted, scope: 'turn' } : choice === 'always' ? { permissions: granted, scope: 'session' } : none))
    }

    /** The MCP call running on the turn that an elicitation is about (it carries no item id). */
    private mcpCallOf(name: string, transcript: AcpTranscript): ToolCall | undefined {
        return (transcript.streaming?.content ?? [])
            .filter((c): c is ToolCall => c.type === 'toolCall' && c.name === name)
            .at(-1)
    }

    /**
     * An MCP server asking the user (elicitation): Codex's own approval of an MCP tool call, a form, or
     * a page to visit. Device verification can't be answered here and is declined.
     */
    private elicitation(params: any, transcript = this.transcript): Promise<unknown> {
        const decline = { action: 'decline', content: null }
        const cancel = { action: 'cancel', content: null }
        if (this.options.readOnly)
            return Promise.resolve(cancel)
        const server = String(params?.serverName ?? '')
        const meta = params?._meta ?? {}
        const message = String(params?.message ?? '')
        if (meta.codex_approval_kind === 'mcp_tool_call') {
            const tool = /"([^"]+)"/.exec(message)?.[1] ?? ''
            const name = `${server}.${tool}`
            const shown = this.mcpCallOf(name, transcript)
            const persist: string[] = Array.isArray(meta.persist) ? meta.persist : []
            const args = (Array.isArray(meta.tool_params_display) ? meta.tool_params_display : [])
                .map((p: any) => `${p.display_name ?? p.name}: ${typeof p.value === 'string' ? p.value : JSON.stringify(p.value)}`)
            const approval: ApprovalRequest = {
                toolCallId: shown?.id ?? `mcp-${name}`,
                tool: name,
                summary: [name, ...args].join('\n'),
                scope: persist.includes('session') ? 'codex' : '',
                alwaysLabel: tr(`本会话都允许 ${name}`, `Allow ${name} for this session`),
            }
            return this.approvalPrompt(approval, choice => (choice === 'allow'
                ? { action: 'accept', content: {} }
                : choice === 'always' ? { action: 'accept', content: {}, _meta: { persist: 'session' } } : choice === 'deny' ? decline : cancel))
        }
        if (params?.mode === 'url') {
            // The page is the user's to open; allow says it was done.
            const approval: ApprovalRequest = { toolCallId: `mcp-url-${randomUUID()}`, tool: server || 'mcp', summary: `${message}\n${String(params.url ?? '')}`, scope: '' }
            return this.approvalPrompt(approval, choice => (choice === 'allow' ? { action: 'accept', content: null } : choice === 'deny' ? decline : cancel))
        }
        if (params?.mode !== 'form' && params?.mode !== 'openai/form' && params?.mode !== 'openaiForm')
            return Promise.resolve(decline)
        const { questions, fields } = elicitForm(message, params.requestedSchema)
        if (!questions.length) {
            // Nothing to fill in: a yes or no.
            const approval: ApprovalRequest = { toolCallId: `mcp-ask-${randomUUID()}`, tool: server || 'mcp', summary: message, scope: '' }
            return this.approvalPrompt(approval, choice => (choice === 'allow' ? { action: 'accept', content: {} } : choice === 'deny' ? decline : cancel))
        }
        const id = `codex-elicit-${randomUUID()}`
        transcript.update({ sessionUpdate: 'tool_call', toolCallId: id, status: 'in_progress', _meta: { piCalls: [call(id, 'ask', { questions })] } })
        return new Promise((resolve) => {
            this.elicits.set(id, { resolve, questions, fields, transcript })
            if (!transcript.setDetails(id, { kind: 'ask', status: 'pending', questions })) {
                this.elicits.delete(id)
                resolve(cancel)
            }
        })
    }

    /** The ask form filled in for an MCP server; nothing filled in cancels. */
    private answerElicit(id: string, response: AskResponse) {
        const wait = this.elicits.get(id)!
        const content = 'answers' in response ? elicitContent(wait.fields, response.answers) : {}
        if (!content)
            throw new Error(tr('这里要填数字', 'That answer has to be a number'))
        this.elicits.delete(id)
        const answered = Object.keys(content).length > 0
        const shown = 'answers' in response ? codexAnswers(wait.questions, response).shown : {}
        wait.transcript.setDetails(id, answered ? { kind: 'ask', status: 'answered', questions: wait.questions, answers: shown } : { kind: 'ask', status: 'cancelled', questions: wait.questions })
        wait.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
        wait.resolve(answered ? { action: 'accept', content } : { action: 'cancel', content: null })
    }

    private answerApproval(requestId: string, payload: Record<string, unknown>) {
        const wait = this.approvals.get(requestId)
        if (!wait)
            return
        this.approvals.delete(requestId)
        const value = payload.cancelled ? undefined : payload.value
        wait.resolve(wait.reply(value === 'allow' || value === 'always' || value === 'deny' ? value : 'cancel'))
    }

    /** request_user_input (plan mode) → the ask capability's form, as a call of its own on the turn. */
    private ask(params: any): Promise<unknown> {
        const id = String(params?.itemId ?? '') || `codex-ask-${randomUUID()}`
        const questions = askQuestionsOf(params?.questions)
        if (this.options.readOnly || !questions.length || this.asks.has(id))
            return Promise.resolve({ answers: {} })
        this.transcript.update({ sessionUpdate: 'tool_call', toolCallId: id, status: 'in_progress', _meta: { piCalls: [call(id, 'ask', { questions })] } })
        return new Promise((resolve) => {
            this.asks.set(id, { resolve, questions })
            if (!this.transcript.setDetails(id, { kind: 'ask', status: 'pending', questions })) {
                this.asks.delete(id)
                resolve({ answers: {} })
            }
        })
    }

    private answerAsk(id: string, response: AskResponse) {
        if (this.elicits.has(id))
            return this.answerElicit(id, response)
        const wait = this.asks.get(id)
        if (!wait)
            throw new Error(tr('这个问题已经不在等回答了', 'This question is no longer waiting for an answer'))
        this.asks.delete(id)
        const { codex, shown } = codexAnswers(wait.questions, response)
        const answered = Object.keys(codex).length > 0
        this.transcript.setDetails(id, answered ? { kind: 'ask', status: 'answered', questions: wait.questions, answers: shown } : { kind: 'ask', status: 'cancelled', questions: wait.questions })
        this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
        wait.resolve({ answers: codex })
    }

    /** The proposed plan's review: accept leaves plan mode and starts on it, feedback revises it. */
    private decidePlan(id: string, decision: PlanDecision) {
        const wait = this.planWait
        if (!wait || wait.id !== id)
            throw new Error(tr('这个计划已经不在等审批了', 'This plan is no longer waiting for a decision'))
        this.planWait = null
        const feedback = 'feedback' in decision ? decision.feedback.trim() : ''
        const details = 'approve' in decision
            ? { kind: 'plan' as const, status: 'approved' as const, plan: wait.plan }
            : feedback ? { kind: 'plan' as const, status: 'revised' as const, plan: wait.plan, feedback } : { kind: 'plan' as const, status: 'cancelled' as const, plan: wait.plan }
        this.transcript.setDetails(id, details)
        this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
        this.transcript.finish('end_turn', wait.usage)
        if (details.status === 'approved') {
            this.mode = this.workMode
            this.configChanged()
            this.run(IMPLEMENT_PLAN, [])
        }
        else if (details.status === 'revised') {
            this.run(feedback, [])
        }
        else {
            this.afterTurn(false)
        }
    }

    /** Approvals, questions and a plan still waiting get a cancel (stop, exit). */
    private cancelWaits() {
        for (const [id] of this.approvals)
            this.answerApproval(id, { cancelled: true })
        for (const id of [...this.asks.keys(), ...this.elicits.keys()])
            this.answerAsk(id, { cancelled: true })
        if (this.planWait && !this.exited)
            this.decidePlan(this.planWait.id, { cancelled: true })
        this.planWait = null
    }

    /** The capability forms' hidden commands (`/gui-ask-answer <id> <json>`, …); false if not one. */
    private async guiCommand(message: string): Promise<boolean> {
        const m = /^\/(gui-ask-answer|gui-plan-decide|gui-rewind|gui-subagent-steer|gui-subagent-cancel) (\S+)(?: ([\s\S]+))?$/.exec(message)
        if (!m)
            return false
        if (m[1] === 'gui-rewind') {
            await this.rewind(m[2])
        }
        else if (m[1] === 'gui-subagent-steer') {
            const sub = this.subagentOf(m[2])
            await this.rpc('turn/steer', { threadId: sub.threadId, expectedTurnId: sub.turnId, input: inputOf(m[3] ?? '', []) })
        }
        else if (m[1] === 'gui-subagent-cancel') {
            const sub = this.subagentOf(m[2])
            await this.rpc('turn/interrupt', { threadId: sub.threadId, turnId: sub.turnId })
        }
        else if (m[1] === 'gui-ask-answer')
            this.answerAsk(m[2], JSON.parse(m[3] ?? '{}') as AskResponse)
        else
            this.decidePlan(m[2], JSON.parse(m[3] ?? '{}') as PlanDecision)
        return true
    }

    // ---------------------------------------------------------------- turns

    private emitQueue() {
        this.emit({ type: 'queue_update', steering: [], followUp: this.queued.map(q => q.message) })
    }

    private async prompt(message: string, images: ImageContent[], steer: boolean) {
        if (images.length && this.currentModel()?.images === false)
            throw new Error(tr(`${this.currentModel()!.name} 不接受图片`, `${this.currentModel()!.name} does not take images`))
        // Typed while a plan waits for review: that is feedback on it.
        if (this.planWait) {
            this.decidePlan(this.planWait.id, { feedback: message })
            return {}
        }
        if (this.running) {
            if (steer && this.turnId) {
                try {
                    await this.rpc('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: inputOf(message, images) })
                    this.transcript.userPrompt(message, images)
                    return {}
                }
                catch {
                    // The turn ended meanwhile: the message goes as the next one.
                }
            }
            if (this.running) {
                this.queued.push({ message, images })
                this.emitQueue()
                return {}
            }
        }
        await this.takeOver()
        this.running = true
        this.emit({ type: 'agent_start' })
        this.run(message, images)
        return {}
    }

    /** One turn/start; the turn streams in and ends with turn/completed. */
    private run(message: string, images: ImageContent[]) {
        this.transcript.userPrompt(message, images)
        const at = this.transcript.messages.length - 1
        this.callbacks.onSession?.(this, { prompt: message })
        this.turnId = null
        this.turnStarting = true
        this.turnError = ''
        this.planItem = null
        this.turnBase = this.tokens
        this.rpc('turn/start', { threadId: this.threadId, input: inputOf(message, images), ...this.turnSettings() }).then(
            (result: any) => {
                this.turnStarting = false
                const id = String(result?.turn?.id ?? '')
                if (id) {
                    this.turnId ??= id
                    this.turnAt.set(at, id)
                }
                if (this.abortWanted)
                    void this.interrupt()
            },
            (error: any) => {
                this.turnStarting = false
                this.transcript.finish(undefined, undefined, this.explain(error))
                this.afterTurn(true)
            },
        )
    }

    private turnCompleted(turn: any) {
        if (!this.running)
            return
        const status = String(turn?.status ?? '')
        const usage = this.tokens ? usageBetween(this.turnBase, this.tokens) : undefined
        this.turnId = null
        this.abortWanted = false
        // Approvals and questions belong to the turn; Codex has dropped any still open.
        for (const [id] of this.approvals) {
            this.answerApproval(id, { cancelled: true })
            this.emit({ type: 'extension_ui_cancel', id })
        }
        for (const id of [...this.asks.keys(), ...this.elicits.keys()])
            this.answerAsk(id, { cancelled: true })
        // A subagent still working when its parent's turn ends: the call shows it as it stands.
        for (const sub of this.subagents.values())
            this.closeSubagent(sub, sub.status)
        const plan = this.planItem
        this.planItem = null
        if (status === 'completed' && plan && plan.text.trim()) {
            this.planWait = { id: plan.id, plan: plan.text, usage }
            this.transcript.setDetails(plan.id, { kind: 'plan', status: 'pending', plan: plan.text })
            return
        }
        const error = status === 'failed' ? this.explain(turn?.error?.message || this.turnError || tr('这一轮失败了', 'The turn failed')) : undefined
        this.transcript.finish(status === 'interrupted' ? 'cancelled' : 'end_turn', usage, error)
        this.afterTurn(status === 'interrupted')
    }

    /** A turn ended: the next follow-up goes, or the run ends. */
    private afterTurn(cancelled: boolean) {
        const next = cancelled ? undefined : this.queued.shift()
        if (next && !this.exited) {
            this.emitQueue()
            this.run(next.message, next.images)
            return
        }
        this.running = false
        this.emit({ type: 'agent_end' })
        this.emit({ type: 'agent_settled' })
        this.callbacks.onSession?.(this, {})
    }

    private async interrupt() {
        this.abortWanted = false
        if (this.turnId)
            await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
    }

    /** Ask again: the thread goes back to before the prompt at `entryId`; the files stay as they are. */
    private async rewind(entryId: string) {
        if (this.running)
            throw new Error(tr('运行中不能重问，先停止或等它结束', 'Cannot ask again while running; stop it or wait for it to finish'))
        const at = Number(entryId)
        const turnId = this.turnAt.get(at)
        if (!turnId)
            throw new Error(tr('这条消息不是一轮的开头，不能从这里重问', 'This message does not start a turn; cannot ask again from here'))
        await this.takeOver()
        await this.rpc('thread/revert', { threadId: this.threadId, beforeTurnId: turnId })
        this.cut(at)
        this.callbacks.onSession?.(this, {})
    }

    /** Forget the transcript from position `at` on. */
    private cut(at: number) {
        this.transcript.truncate(at)
        for (const position of [...this.turnAt.keys()]) {
            if (position >= at)
                this.turnAt.delete(position)
        }
    }

    /**
     * pi's fork: this process moves to a new thread holding the turns before `entryId` (a prompt),
     * and the prompt comes back to edit. The thread it came from stays as it was.
     */
    private async forkAt(entryId: string) {
        if (this.running)
            throw new Error(tr('运行中不能分叉，先停止或等它结束', 'Cannot fork while running; stop it or wait for it to finish'))
        const at = Number(entryId)
        const turnId = this.turnAt.get(at)
        const prompt = this.transcript.messages[at]?.message
        if (!turnId || prompt?.role !== 'user')
            throw new Error(tr('这条消息不是一轮的开头，不能从这里分叉', 'This message does not start a turn; cannot fork from here'))
        const content = prompt.content
        const text = typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => (c as any).text).join('')
        const result: any = await this.rpc('thread/fork', { threadId: this.threadId, beforeTurnId: turnId, excludeTurns: true })
        const forked = String(result?.thread?.id ?? '')
        if (!forked)
            throw new Error(tr('分叉没有返回线程', 'The fork returned no thread'))
        this.cut(at)
        // Listed under its own key, with the transcript before the prompt; then this process is it
        // (thread/fork loads the fork here, so it writes it).
        this.callbacks.onFork?.(this, forked)
        this.threadId = forked
        this.detached = false
        this.callbacks.onSession?.(this, {})
        return { text }
    }

    // ---------------------------------------------------------------- pi RPC

    /** Fire-and-forget records from the renderer (extension_ui_response). */
    write(record: Record<string, unknown>) {
        if (record.type === 'extension_ui_response' && typeof record.id === 'string')
            this.answerApproval(record.id, record)
    }

    async request(command: Record<string, unknown>): Promise<RpcResponse> {
        const type = String(command.type)
        const ok = (data?: unknown): RpcResponse => ({ type: 'response', command: type, success: true, data })
        try {
            await this.ready
            switch (type) {
                case 'get_state':
                    return ok({
                        model: this.piModel(),
                        thinkingLevel: this.effort || undefined,
                        isStreaming: this.running,
                        isCompacting: false,
                        sessionFile: this.key,
                        sessionId: this.threadId,
                        sessionName: undefined,
                        configOptions: this.configOptions(),
                        agentCaps: this.caps,
                    })
                case 'get_available_models':
                    return ok({ models: this.models.map(m => ({ id: m.id, name: m.name, provider: this.spec.label })) })
                case 'get_available_thinking_levels':
                    return ok({ levels: (this.currentModel()?.efforts ?? []).map(e => e.value) })
                case 'get_commands':
                    return ok({ commands: [{ name: 'compact', description: tr('压缩上下文，腾出空间', 'Summarize the conversation to free up context'), source: 'prompt' }] })
                case 'get_session_stats': {
                    const tokens = this.transcript.totals()
                    const context = this.context
                    return ok({
                        tokens,
                        cost: undefined,
                        contextUsage: context ? { tokens: context.used, contextWindow: context.size, percent: context.size ? (context.used / context.size) * 100 : null } : undefined,
                    })
                }
                case 'prompt': {
                    const message = String(command.message ?? '')
                    if (await this.guiCommand(message))
                        return ok({ disposition: 'handled' })
                    if (message.trim() === '/compact' && !this.running)
                        return ok(await this.compact())
                    return ok(await this.prompt(message, Array.isArray(command.images) ? command.images as ImageContent[] : [], command.streamingBehavior === 'steer'))
                }
                case 'abort':
                    this.cancelWaits()
                    for (const sub of this.subagents.values()) {
                        if (!sub.closed && sub.turnId)
                            void this.rpc('turn/interrupt', { threadId: sub.threadId, turnId: sub.turnId }).catch(() => {})
                    }
                    if (this.turnId)
                        await this.interrupt()
                    else if (this.turnStarting)
                        this.abortWanted = true
                    return ok()
                case 'clear_queue': {
                    const followUp = this.queued.map(q => q.message)
                    this.queued = []
                    this.emitQueue()
                    return ok({ steering: [], followUp })
                }
                case 'compact':
                    return ok(await this.compact())
                case 'fork':
                    return ok(await this.forkAt(String(command.entryId ?? '')))
                case 'acp_fork': {
                    if (this.running)
                        throw new Error(tr('运行中不能分叉，先停止或等它结束', 'Cannot fork while running; stop it or wait for it to finish'))
                    const result: any = await this.rpc('thread/fork', { threadId: this.threadId, excludeTurns: true })
                    const forked = String(result?.thread?.id ?? '')
                    if (!forked)
                        throw new Error(tr('分叉没有返回线程', 'The fork returned no thread'))
                    return ok({ sessionFile: this.callbacks.onFork?.(this, forked) ?? acpSessionKey(this.spec.id, forked) })
                }
                case 'set_model':
                    this.setConfig('model', String(command.modelId ?? ''))
                    return ok()
                case 'set_thinking_level':
                    this.setConfig('reasoning_effort', String(command.level ?? ''))
                    return ok()
                case 'set_config_option':
                    this.setConfig(String(command.configId ?? ''), String(command.value ?? ''))
                    return ok({ configOptions: this.configOptions() })
                case 'set_session_name': {
                    const name = String(command.name ?? '')
                    this.callbacks.onSession?.(this, { name })
                    if (name.trim()) {
                        await this.rpc('thread/name/set', { threadId: this.threadId, name: name.trim() })
                            .catch(error => console.warn(`[codex] rename failed:`, error?.message ?? error))
                    }
                    return ok()
                }
                default:
                    return { type: 'response', command: type, success: false, error: tr(`${this.spec.label} 不支持这个操作（${type}）`, `${this.spec.label} does not support this (${type})`) }
            }
        }
        catch (error: any) {
            return { type: 'response', command: type, success: false, error: String(error?.message ?? error) }
        }
    }

    private piModel(): PiModel | undefined {
        if (!this.model)
            return undefined
        return { id: this.model, name: this.currentModel()?.name ?? this.model, provider: this.spec.label, reasoning: !!this.currentModel()?.efforts.length } as PiModel
    }

    /** Codex compacts as a turn of its own (a contextCompaction item); it streams in and settles like one. */
    private async compact() {
        if (this.running)
            throw new Error(tr('运行中不能压缩，等它结束或先停止', 'Cannot compact while running; wait or stop it first'))
        await this.takeOver()
        this.running = true
        this.turnBase = this.tokens
        this.emit({ type: 'agent_start' })
        try {
            await this.rpc('thread/compact/start', { threadId: this.threadId })
        }
        catch (error) {
            this.running = false
            this.emit({ type: 'agent_end' })
            this.emit({ type: 'agent_settled' })
            throw error
        }
        return {}
    }

    stop(): Promise<void> {
        if (this.exited)
            return Promise.resolve()
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000)
            this.child.once('exit', () => {
                clearTimeout(timer)
                resolve()
            })
            this.child.stdin.end()
            this.child.kill('SIGTERM')
        })
    }
}

// ---------------------------------------------------------------- outside a thread

/** A short-lived app-server for one piece of work (the thread list, a delete). */
async function withAppServer<T>(launch: CodexLaunch, work: (rpc: (method: string, params: unknown) => Promise<any>) => Promise<T>, timeoutMs = 20_000): Promise<T> {
    const child = spawn(launch.file, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'ignore'], windowsVerbatimArguments: launch.windowsVerbatimArguments })
    const connection = new AcpConnection(child.stdin, child.stdout, {
        onNotification: () => {},
        onRequest: async method => Promise.reject(new RpcError(`Method not found: ${method}`, -32601)),
    })
    const exited = new Promise<never>((_resolve, reject) => {
        child.on('error', reject)
        child.on('exit', code => reject(new Error(`codex app-server exited (${code})`)))
    })
    exited.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('codex app-server: timed out')), timeoutMs)
    })
    const run = async () => {
        await connection.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } })
        connection.notify('initialized', undefined)
        return work((method, params) => connection.request(method, params))
    }
    try {
        return await Promise.race([run(), exited, timeout])
    }
    finally {
        clearTimeout(timer)
        connection.close(new Error('closed'))
        child.stdin.end()
        child.kill('SIGTERM')
    }
}

export interface CodexThreadSummary {
    sessionId: string
    cwd: string
    title?: string
    updatedAt: number
}

/** Codex's own thread list (thread/list), newest first; `complete` when every page was read. */
export function listCodexThreads(launch: CodexLaunch, maxPages = 8): Promise<{ sessions: CodexThreadSummary[], complete: boolean }> {
    return withAppServer(launch, async (rpc) => {
        const sessions: CodexThreadSummary[] = []
        let cursor: string | undefined
        for (let page = 0; page < maxPages; page++) {
            const result = await rpc('thread/list', { limit: 100, sourceKinds: LISTED_SOURCES, ...(cursor ? { cursor } : {}) })
            for (const t of result?.data ?? []) {
                if (typeof t?.id !== 'string' || !t.id || typeof t.cwd !== 'string' || !t.cwd)
                    continue
                const title = (typeof t.name === 'string' && t.name.trim()) || (typeof t.preview === 'string' && t.preview.trim()) || ''
                // Seconds.
                const at = typeof t.updatedAt === 'number' ? t.updatedAt : typeof t.createdAt === 'number' ? t.createdAt : 0
                sessions.push({ sessionId: t.id, cwd: t.cwd, title: title ? title.slice(0, 200) : undefined, updatedAt: at * 1000 })
            }
            cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
            if (!cursor)
                return { sessions, complete: true }
        }
        return { sessions, complete: false }
    })
}

/** Deletes a thread from Codex's own history. */
export function deleteCodexThread(launch: CodexLaunch, threadId: string): Promise<void> {
    return withAppServer(launch, async (rpc) => {
        await rpc('thread/delete', { threadId })
    })
}
