// A scripted ACP agent for test/acp-e2e.ts, shaped like codex-acp (config options, terminal output
// deltas, diff content, request_permission, session/load replay). Sessions persist as JSONL of
// the updates sent, under FAKE_ACP_DIR, so a reopened thread replays them; <id>.meta.json holds
// what session/list reports (agent, cwd, title, updatedAt). `--agent=<id>` picks whose sessions
// it lists, since every agent of the e2e runs this one script.
//
//   "edit <file>"  runs `ls`, asks to write <file> (diff), writes it once allowed, then answers
//   anything else  answers "echo: <prompt>"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DIR = process.env.FAKE_ACP_DIR || '/tmp/fake-acp'
const AGENT = process.argv.find(a => a.startsWith('--agent='))?.slice('--agent='.length) ?? 'codex'
mkdirSync(DIR, { recursive: true })

const metaFile = id => path.join(DIR, `${id}.meta.json`)
function touch(session, patch = {}) {
    const meta = existsSync(metaFile(session.id)) ? JSON.parse(readFileSync(metaFile(session.id), 'utf8')) : { agent: AGENT, cwd: session.cwd }
    writeFileSync(metaFile(session.id), JSON.stringify({ ...meta, ...patch, updatedAt: new Date().toISOString() }))
}

const sessions = new Map()
const pending = new Map()
let nextId = 0
let buffer = ''

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const request = (method, params) => new Promise((resolve) => {
    const id = `agent-${++nextId}`
    pending.set(id, resolve)
    write({ jsonrpc: '2.0', id, method, params })
})

function configOptions(session) {
    return [
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.mode, options: [
            { value: 'read-only', name: 'Read-only', description: 'Asks before edits' },
            { value: 'agent', name: 'Auto review', description: 'Only asks for risky actions' },
        ] },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: [
            { value: 'fake-1', name: 'Fake One' },
            { value: 'fake-2', name: 'Fake Two' },
        ] },
        { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: session.effort, options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
        ] },
    ]
}

function update(session, update, { record = true } = {}) {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session.id, update } })
    if (record)
        appendFileSync(path.join(DIR, `${session.id}.jsonl`), `${JSON.stringify(update)}\n`)
}

const say = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

async function prompt(session, params) {
    const text = (params.prompt ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    // Recorded for replay only: ACP does not echo the prompt live.
    appendFileSync(path.join(DIR, `${session.id}.jsonl`), `${JSON.stringify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })}\n`)
    session.cancelled = false
    touch(session, existsSync(metaFile(session.id)) ? {} : { title: text })
    const edit = /^edit (\S+)/.exec(text)
    if (!edit) {
        update(session, say(`echo: ${text}`))
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }
    }
    const file = path.join(session.cwd, edit[1])
    update(session, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking around first.' } })
    update(session, { sessionUpdate: 'tool_call', toolCallId: 'ls-1', kind: 'execute', title: 'ls', status: 'in_progress', rawInput: { command: 'ls', cwd: session.cwd } })
    update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'ls-1', _meta: { terminal_output_delta: { data: 'README.md\n', terminal_id: 'ls-1' } } })
    update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'ls-1', status: 'completed', rawOutput: { exit_code: 0 } })
    const old = existsSync(file) ? readFileSync(file, 'utf8') : null
    const diff = { type: 'diff', path: file, oldText: old, newText: 'written by fake\n' }
    update(session, { sessionUpdate: 'tool_call', toolCallId: 'edit-1', kind: 'edit', title: 'Editing files', status: 'in_progress', content: [diff] })
    const answer = await request('session/request_permission', {
        sessionId: session.id,
        toolCall: { toolCallId: 'edit-1', title: 'Edit files', kind: 'edit', status: 'pending', locations: [{ path: file }] },
        options: [
            { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
            { optionId: 'allow_for_session', name: 'Yes, and don\'t ask again for these files', kind: 'allow_always' },
            { optionId: 'cancel', name: 'No, and tell the agent what to do differently', kind: 'reject_once' },
        ],
    })
    if (session.cancelled)
        return { stopReason: 'cancelled' }
    const allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId !== 'cancel'
    if (allowed)
        writeFileSync(file, diff.newText)
    update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: allowed ? 'completed' : 'failed' })
    update(session, { sessionUpdate: 'plan', entries: [{ content: 'Look around', status: 'completed', priority: 'high' }, { content: `Write ${edit[1]}`, status: allowed ? 'completed' : 'pending', priority: 'high' }] })
    update(session, say(allowed ? `Wrote ${edit[1]}.` : 'Not allowed, left it alone.'))
    update(session, { sessionUpdate: 'session_info_update', title: `Edit ${edit[1]}` }, { record: false })
    touch(session, { title: `Edit ${edit[1]}` })
    update(session, { sessionUpdate: 'usage_update', used: 1200, size: 100_000 }, { record: false })
    return { stopReason: 'end_turn', usage: { inputTokens: 1000, cachedReadTokens: 400, outputTokens: 50, thoughtTokens: 5, totalTokens: 1050 } }
}

function newSession(id, cwd) {
    const session = { id, cwd, mode: 'read-only', model: 'fake-1', effort: 'low', cancelled: false }
    sessions.set(id, session)
    return session
}

const handlers = {
    initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } },
        authMethods: [],
        _meta: { steering: { supported: false } },
    }),
    'session/new': (params) => {
        const session = newSession(`fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, params.cwd)
        setTimeout(() => update(session, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the changes' }] }, { record: false }), 10)
        return { sessionId: session.id, configOptions: configOptions(session) }
    },
    'session/load': (params) => {
        const session = newSession(params.sessionId, params.cwd)
        const file = path.join(DIR, `${session.id}.jsonl`)
        if (!existsSync(file))
            throw Object.assign(new Error('Session not found'), { code: -32002 })
        for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean))
            update(session, JSON.parse(line), { record: false })
        return { configOptions: configOptions(session) }
    },
    'session/list': () => ({
        sessions: readdirSync(DIR).filter(f => f.endsWith('.meta.json')).map((f) => {
            const meta = JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))
            return { sessionId: f.slice(0, -'.meta.json'.length), cwd: meta.cwd, title: meta.title, updatedAt: meta.updatedAt, agent: meta.agent }
        }).filter(s => s.agent === AGENT).map(({ agent, ...s }) => s),
    }),
    'session/set_config_option': (params) => {
        const session = sessions.get(params.sessionId)
        const key = { mode: 'mode', model: 'model', reasoning_effort: 'effort' }[params.configId]
        if (!session || !key)
            throw new Error('bad config option')
        session[key] = params.value
        return { configOptions: configOptions(session) }
    },
    'session/prompt': params => prompt(sessions.get(params.sessionId), params),
}

async function receive(message) {
    if (message.method === 'session/cancel') {
        const session = sessions.get(message.params?.sessionId)
        if (session)
            session.cancelled = true
        for (const [id, resolve] of pending) {
            pending.delete(id)
            resolve({ outcome: { outcome: 'cancelled' } })
        }
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
