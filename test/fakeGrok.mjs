// A scripted Grok Build agent (`grok agent stdio`) for electron/acp/grok.test.ts. Every message is
// shaped like one recorded from Grok Build 1.0.46, or taken from its source (xai-org/grok-build):
// `_x.ai/…` extension notifications, turns tagged with the prompt's `_meta.promptId`, Bash output
// as the whole output so far, ask_user_question / exit_plan_mode as agent → client requests,
// interjections drained between model calls or run as `interject-fallback-…` turns.
// Sessions persist as JSONL under FAKE_GROK_DIR: what Grok stores (eventId'd updates, and the
// user chunks it stores without sending), replayed by session/load as Grok replays them.
//
//   "bash"   runs `echo one; sleep; echo two; exit 3`, streaming its output, then says "done"
//            (with what it heard, for an interjection meanwhile)
//   "ask"    asks two questions (one multi-select), then says what it heard
//   "plan"   proposes a plan with exit_plan_mode, then says what came of it
//   "slow"   streams a reply for a while; an interjection meanwhile is taken in before a second call
//   "late"   ends at once, but lets an interjection that comes in its last call strand
//   "fail"   fails the prompt request
//   other    answers "echo: <prompt>"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

const DIR = process.env.FAKE_GROK_DIR || '/tmp/fake-grok'
mkdirSync(DIR, { recursive: true })

const sessions = new Map()
const pending = new Map()
let nextId = 0
let buffer = ''
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const request = (method, params) => new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    write({ jsonrpc: '2.0', id, method, params })
})
const store = (session, line) => appendFileSync(path.join(DIR, `${session.id}.jsonl`), `${JSON.stringify(line)}\n`)

/** A session/update as Grok sends it live; stored (with its eventId) unless `transient`. */
function update(session, update, { transient = false, meta = {} } = {}) {
    const _meta = transient ? undefined : { totalTokens: session.tokens, eventId: `${session.id}-${++session.events}`, agentTimestampMs: Date.now(), promptId: session.promptId, ...meta }
    const params = { sessionId: session.id, update, ...(_meta ? { _meta } : {}) }
    write({ jsonrpc: '2.0', method: 'session/update', params })
    if (!transient)
        store(session, { method: 'session/update', params })
}
/** An x.ai session notification: `_x.ai/session_notification` live, stored as `_x.ai/session/update`. */
function xai(session, update, { stored = true } = {}) {
    const params = { sessionId: session.id, update, ...(stored ? { _meta: { eventId: `${session.id}-${++session.events}`, agentTimestampMs: Date.now() } } : {}) }
    write({ jsonrpc: '2.0', method: '_x.ai/session_notification', params })
    if (stored)
        store(session, { method: '_x.ai/session/update', params })
}
/** A user message Grok stores but does not send (an interjection, a fallback turn's prompt). */
function storeUser(session, text, contentMeta) {
    store(session, { method: 'session/update', params: { sessionId: session.id, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text, ...(contentMeta ? { _meta: contentMeta } : {}) }, _meta: { modelId: session.model } }, _meta: { eventId: `${session.id}-${++session.events}`, agentTimestampMs: Date.now() } } })
}

const say = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const tool = (name, kind) => ({ 'x.ai/tool': { version: 1, name, kind, namespace: 'grok_build', label: name, read_only: kind !== 'execute' } })
const callUsage = { input_tokens: 135, output_tokens: 15, cache_read_input_tokens: 18432, cache_creation_input_tokens: 0, reasoning_tokens: 14 }
const turnUsage = calls => ({ inputTokens: 18567 * calls, outputTokens: 15 * calls, totalTokens: 18582 * calls, cachedReadTokens: 18432 * calls, cacheCreationTokens: 0, reasoningTokens: 14 * calls, modelCalls: calls, apiDurationMs: 900 * calls, costUsdTicks: 79407000 * calls, numTurns: calls })

function modelCall(session) {
    session.calls++
    session.tokens += 100
}
function endCall(session) {
    xai(session, { sessionUpdate: 'response_completed', usage: callUsage, signature: 'sig' }, { stored: false })
}
/** Interjections waiting are taken in before the next model call, stored wrapped with the typed text. */
function drain(session) {
    const taken = session.interjections.splice(0)
    for (const text of taken)
        storeUser(session, `The user sent a message while you were working:\n<user_query>\n${text}\n</user_query>\nIf the user is asking for a response, address the user first. After replying, complete any unfinished tasks from previous turns.`, { displayText: text })
    return taken
}

function queueChanged(session, running) {
    write({ jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId: session.id, entries: [], ...(running ? { runningPromptId: running.id, runningText: running.text, runningKind: 'prompt' } : {}) } })
}

/** Ends a turn as Grok does: turn_completed (stored), the transient plan clearing, prompt_complete. */
function endTurn(session, stopReason = 'end_turn') {
    xai(session, { sessionUpdate: 'turn_completed', prompt_id: session.promptId, stop_reason: stopReason, usage: turnUsage(session.calls), elapsed_ms: 10 })
    update(session, { sessionUpdate: 'plan', entries: [] }, { transient: true })
    const result = { stopReason, _meta: { sessionId: session.id, requestId: session.promptId, promptId: session.promptId, totalTokens: session.tokens, modelId: session.model, usage: turnUsage(session.calls) } }
    // Interjections that missed the turn become turns of their own, queued before this one answers.
    const stranded = session.interjections.splice(0)
    for (const text of stranded)
        session.fallbacks.push({ id: `interject-fallback-${randomUUID()}`, text })
    if (session.fallbacks.length)
        queueChanged(session, session.fallbacks[0])
    write({ jsonrpc: '2.0', method: '_x.ai/session/prompt_complete', params: { sessionId: session.id, promptId: session.promptId, stopReason, agentResult: null } })
    return result
}

async function runFallbacks(session) {
    while (session.fallbacks.length) {
        const turn = session.fallbacks.shift()
        session.promptId = turn.id
        session.calls = 0
        storeUser(session, turn.text)
        modelCall(session)
        update(session, say(`heard: ${turn.text}`))
        endCall(session)
        endTurn(session)
        if (session.fallbacks.length)
            queueChanged(session, session.fallbacks[0])
    }
    queueChanged(session)
}

async function prompt(session, params) {
    const text = (params.prompt ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    session.promptId = params._meta?.promptId ?? randomUUID()
    session.calls = 0
    session.cancelled = false
    storeUser(session, text)
    queueChanged(session, { id: session.promptId, text })
    if (text === 'fail')
        throw Object.assign(new Error('Internal error'), { code: -32603 })
    modelCall(session)
    if (text === 'bash') {
        const id = 'call-b5f46c9f-48df-4853-887e-e439e57611c2-0'
        const command = 'echo one; sleep 4; echo two; exit 3'
        update(session, say('I\'ll run that command now.'))
        xai(session, { sessionUpdate: 'tool_call_delta_chunk', tool_call_id: id, delta: '{"command"' }, { stored: false })
        // Grok sends a response's tool calls after its response_completed.
        endCall(session)
        update(session, { sessionUpdate: 'tool_call', toolCallId: id, title: 'run_terminal_command', rawInput: { command, description: 'Run specified echo/sleep command' }, _meta: tool('run_terminal_command', 'execute') })
        update(session, { sessionUpdate: 'tool_call_update', toolCallId: id, kind: 'execute', title: `Execute \`${command}\``, content: [{ type: 'content', content: { type: 'text', text: 'Run specified echo/sleep command' } }], locations: [], rawInput: { variant: 'Bash', command, description: 'Run specified echo/sleep command', is_background: false }, _meta: tool('run_terminal_command', 'execute') })
        const bash = (output, extra = {}) => ({ type: 'Bash', output: [], output_for_prompt: output, exit_code: 0, command, truncated: false, signal: null, timed_out: false, description: null, current_dir: session.cwd, output_file: '', total_bytes: output.length, ...extra })
        for (const output of ['', 'one\n', 'one\ntwo\n']) {
            update(session, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: bash(output) }, { transient: true })
            await sleep(Number(process.env.FAKE_GROK_BASH_MS ?? 30))
        }
        update(session, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'one\ntwo\n' } }], rawOutput: bash('exit: 3\none\ntwo\n', { output: [...Buffer.from('one\ntwo\n')], exit_code: 3 }) })
        const heard = drain(session)
        modelCall(session)
        update(session, say(heard.length ? `done, heard: ${heard.join(' / ')}` : 'done'))
        endCall(session)
        return endTurn(session)
    }
    if (text === 'ask') {
        const id = 'call-f89b4f2f-878e-48e2-ba87-026ef33738f9-27'
        const questions = [
            { question: 'Which branch?', options: [{ label: 'main (Recommended)', description: 'The checked-out one.' }, { label: 'poi', description: 'Needs a checkout.' }] },
            { question: 'Which checks, of a, b and c?', options: [{ label: 'lint', description: '' }, { label: 'tests', description: '' }], multiSelect: true },
        ]
        endCall(session)
        update(session, { sessionUpdate: 'tool_call', toolCallId: id, title: 'ask_user_question', rawInput: { questions }, _meta: tool('ask_user_question', 'ask_user') })
        const reply = await request('_x.ai/ask_user_question', { sessionId: session.id, toolCallId: id, questions, mode: 'default' })
        if (session.cancelled)
            return endTurn(session, 'cancelled')
        // format_accepted_tool_result / the cancel text of xai-grok-tools.
        const message = reply?.outcome === 'accepted'
            ? `User has answered your questions: ${Object.entries(reply.answers).map(([q, labels]) => [`"${q}"="${labels.join(', ')}"`, ...(reply.annotations?.[q]?.notes ? [`user notes: ${reply.annotations[q].notes}`] : [])].join(' ')).join(', ')}. You can now continue with the user's answers in mind.`
            : 'User declined to answer the questions. You should continue without their answers and make reasonable assumptions, or ask again if needed.'
        update(session, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: message } }], rawOutput: { type: 'AskUserQuestion', UserAnswered: { message } } })
        modelCall(session)
        update(session, say(reply?.outcome === 'accepted' ? `heard ${JSON.stringify(reply.answers)}` : 'no answer'))
        endCall(session)
        return endTurn(session)
    }
    if (text === 'plan') {
        const id = 'call-0c6d2f1e-plan-0'
        const plan = '# Plan\n\n1. Do A\n2. Do B\n'
        endCall(session)
        update(session, { sessionUpdate: 'tool_call', toolCallId: id, title: 'exit_plan_mode', rawInput: {}, _meta: tool('exit_plan_mode', 'exit_plan') })
        const reply = await request('_x.ai/exit_plan_mode', { sessionId: session.id, toolCallId: id, planContent: plan })
        // tool_calls.rs: approved runs the tool (PlanReady); the others answer with these texts.
        let message
        let rawOutput
        if (reply?.outcome === 'approved') {
            message = 'Your plan has been approved. You can now start coding.'
            rawOutput = { type: 'ExitPlanMode', PlanReady: { message, plan_content: plan, plan_file_path: `${session.cwd}/plan.md` } }
        }
        else if (reply?.outcome === 'abandoned') {
            message = 'The user chose to abandon the plan entirely (via the Abandon option in the plan approval dialog). Plan mode has been disabled. Do not call exit_plan_mode again unless the user explicitly asks to re-enter plan mode.'
        }
        else {
            message = reply?.feedback ? `The user wants to revise the plan. The user said:\n${reply.feedback}` : 'The user wants to revise the plan. Ask the user what changes they would like to make.'
        }
        update(session, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: message } }], ...(rawOutput ? { rawOutput } : {}) })
        if (reply?.outcome !== 'cancelled')
            update(session, { sessionUpdate: 'current_mode_update', currentModeId: 'default' })
        modelCall(session)
        update(session, say(`plan ${reply?.outcome}`))
        endCall(session)
        return endTurn(session)
    }
    if (text === 'slow') {
        update(session, say('working'))
        for (let i = 0; i < 20 && !session.cancelled && !session.interjections.length; i++)
            await sleep(50)
        endCall(session)
        if (session.cancelled)
            return endTurn(session, 'cancelled')
        while (session.interjections.length) {
            const heard = drain(session)
            modelCall(session)
            update(session, say(`heard: ${heard.join(' / ')}`))
            endCall(session)
        }
        return endTurn(session)
    }
    if (text === 'late') {
        update(session, say('quick'))
        // The interjection comes during the last call, after Grok's final drain.
        await sleep(400)
        endCall(session)
        return endTurn(session)
    }
    update(session, say(`echo: ${text}`))
    endCall(session)
    return endTurn(session)
}

function newSession(id, cwd) {
    const session = { id, cwd, model: 'grok-4.6', effort: 'low', mode: 'default', tokens: 18000, events: 0, calls: 0, promptId: '', interjections: [], fallbacks: [], cancelled: false }
    sessions.set(id, session)
    return session
}

const models = [
    { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { totalContextTokens: 256000 } },
    { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 500000 } },
]
const configOptions = session => [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: models.map(m => ({ value: m.modelId, name: m.name })) },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: session.effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
]
const metaFile = id => path.join(DIR, `${id}.meta.json`)

const handlers = {
    'initialize': () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
        authMethods: [{ id: 'cached_token', name: 'cached_token' }, { id: 'grok.com', name: 'Grok' }],
        _meta: { grokShell: true, defaultAuthMethodId: 'cached_token', agentVersion: '1.0.46', modelState: { currentModelId: 'grok-4.6', availableModels: models } },
    }),
    'session/new': (params) => {
        const session = newSession(randomUUID(), params.cwd)
        writeFileSync(metaFile(session.id), JSON.stringify({ cwd: params.cwd }))
        setTimeout(() => update(session, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compress conversation history to save context window', input: null }] }, { transient: true }), 5)
        return { sessionId: session.id, models: { currentModelId: session.model, availableModels: models }, configOptions: configOptions(session) }
    },
    'session/load': (params) => {
        const file = path.join(DIR, `${params.sessionId}.jsonl`)
        if (!existsSync(file))
            throw Object.assign(new Error('Session not found'), { code: -32002 })
        const session = newSession(params.sessionId, params.cwd)
        for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
            const stored = JSON.parse(line)
            session.events++
            write({ jsonrpc: '2.0', method: stored.method === 'session/update' ? 'session/update' : '_x.ai/session/update', params: stored.params })
        }
        return { models: { currentModelId: session.model, availableModels: models }, configOptions: configOptions(session) }
    },
    'session/set_config_option': (params) => {
        const session = sessions.get(params.sessionId)
        const key = { model: 'model', reasoning_effort: 'effort' }[params.configId]
        if (!session || !key)
            throw new Error('bad config option')
        session[key] = params.value
        return { configOptions: configOptions(session) }
    },
    'session/set_mode': (params) => {
        const session = sessions.get(params.sessionId)
        session.mode = params.modeId
        update(session, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId })
        return {}
    },
    'session/prompt': async (params) => {
        const session = sessions.get(params.sessionId)
        const result = await prompt(session, params)
        if (session.fallbacks.length)
            setTimeout(() => void runFallbacks(session), 20)
        else
            queueChanged(session)
        return result
    },
    // Double-wrapped, as to_ext_response sends it.
    '_x.ai/interject': (params) => {
        const session = sessions.get(params.sessionId)
        session.interjections.push(params.text)
        write({ jsonrpc: '2.0', method: '_x.ai/session/interjection', params: { sessionId: session.id, text: params.text, interjectionId: params.interjectionId } })
        return { result: { status: 'queued' } }
    },
    '_x.ai/compact_conversation': (params) => {
        const session = sessions.get(params.sessionId)
        const before = session.tokens
        session.tokens = 2000
        xai(session, { sessionUpdate: 'auto_compact_completed', tokens_before: before, tokens_after: session.tokens, summary_preview: null })
        return {}
    },
    '_x.ai/session/fork': (params) => {
        const from = path.join(DIR, `${params.sourceSessionId}.jsonl`)
        if (!existsSync(from))
            throw Object.assign(new Error('Session not found'), { code: -32603 })
        const id = randomUUID()
        writeFileSync(path.join(DIR, `${id}.jsonl`), readFileSync(from, 'utf8').replaceAll(params.sourceSessionId, id))
        writeFileSync(metaFile(id), JSON.stringify({ cwd: params.newCwd, parent: params.sourceSessionId }))
        return { newSessionId: id, chatMessagesCopied: 1, updatesCopied: 1, planStateCopied: false, newCwd: params.newCwd, parentSessionId: params.sourceSessionId }
    },
    '_x.ai/session/rename': (params) => {
        const meta = JSON.parse(readFileSync(metaFile(params.sessionId), 'utf8'))
        writeFileSync(metaFile(params.sessionId), JSON.stringify({ ...meta, title: params.resetToAuto ? undefined : params.title }))
        return { success: true }
    },
    '_x.ai/session/delete': (params) => {
        rmSync(path.join(DIR, `${params.sessionId}.jsonl`), { force: true })
        rmSync(metaFile(params.sessionId), { force: true })
        return { success: true }
    },
}

async function receive(message) {
    if (message.method === 'session/cancel') {
        const session = sessions.get(message.params?.sessionId)
        if (session)
            session.cancelled = true
        return
    }
    if (message.method === undefined && pending.has(message.id)) {
        pending.get(message.id)(message.result)
        pending.delete(message.id)
        return
    }
    const handler = handlers[message.method]
    if (message.id === undefined)
        return
    if (!handler) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
        return
    }
    try {
        write({ jsonrpc: '2.0', id: message.id, result: await handler(message.params ?? {}) })
    }
    catch (error) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } })
    }
}

process.stdin.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (line.trim())
            void receive(JSON.parse(line))
    }
})
process.stdin.on('end', () => process.exit(0))
