// The browser tools as an MCP server over stdio, for the agents that are not pi: Codex, Claude Code and
// the ACP agents (Filo hands it to each thread it starts). It holds no logic of its own. The tools it
// lists and every call it gets go to the app over the unix socket in PI_KIT_BROWSER, the same one pi's
// browser extension (extensions/browser.ts) talks to, so a page opened by any agent is a tab in the
// Browser panel and all agents see the same tools (lib/browserSpec.ts).
//
// Plain JavaScript with no dependencies: the agent starts it with whatever node it has, nothing is built.
//   PI_KIT_BROWSER          the socket        PI_KIT_BROWSER_TOKEN    its token
//   PI_KIT_BROWSER_CWD      the thread's project folder
//   PI_KIT_BROWSER_SESSION  who is calling: each caller gets a tab of its own
import net from 'node:net'
import readline from 'node:readline'

const SOCKET = process.env.PI_KIT_BROWSER
const TOKEN = process.env.PI_KIT_BROWSER_TOKEN ?? ''
const CWD = process.env.PI_KIT_BROWSER_CWD || process.cwd()
const SESSION = process.env.PI_KIT_BROWSER_SESSION || `mcp-${process.pid}`
const PROTOCOL = '2025-06-18'

/** Calls in flight by JSON-RPC id, so the client can cancel one. */
const open = new Map()

/** One request to the app; resolves with its answer. */
function ask(body, id) {
    return new Promise((resolve, reject) => {
        if (!SOCKET) {
            reject(new Error('the Filo browser is not available here (PI_KIT_BROWSER is not set)'))
            return
        }
        const socket = net.createConnection(SOCKET)
        let buffer = ''
        if (id !== undefined)
            open.set(id, socket)
        const done = () => {
            if (id !== undefined)
                open.delete(id)
        }
        socket.setEncoding('utf8')
        socket.on('connect', () => socket.write(`${JSON.stringify({ ...body, cwd: CWD, session: SESSION, token: TOKEN })}\n`))
        socket.on('data', (chunk) => {
            buffer += chunk
        })
        socket.on('end', () => {
            done()
            try {
                resolve(JSON.parse(buffer))
            }
            catch {
                reject(new Error('Filo sent no answer'))
            }
        })
        socket.on('close', () => {
            done()
            reject(new Error('cancelled'))
        })
        socket.on('error', (error) => {
            done()
            reject(new Error(`Filo's browser is not reachable (${error.message})`))
        })
    })
}

let listing
/** The tools and instructions, asked once. */
function describe() {
    listing ??= ask({ method: 'tools' }).then((response) => {
        if (!response.ok)
            throw new Error(response.error)
        return response
    }).catch((error) => {
        listing = undefined
        throw error
    })
    return listing
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const reply = (id, result) => send({ id, result })
const fail = (id, code, message) => send({ id, error: { code, message } })

async function handle(message) {
    const { id, method, params } = message
    switch (method) {
        case 'initialize': {
            // Instructions come from the app, which owns the wording; a late or missing app only loses them.
            const instructions = await describe().then(d => d.instructions, () => undefined)
            return reply(id, {
                protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
                capabilities: { tools: {} },
                serverInfo: { name: 'filo-browser', version: '1.0.0' },
                ...(instructions ? { instructions } : {}),
            })
        }
        case 'ping':
            return reply(id, {})
        case 'tools/list': {
            const { tools } = await describe()
            return reply(id, {
                tools: tools.map(t => ({
                    name: t.name,
                    title: t.title,
                    description: t.description,
                    inputSchema: t.inputSchema,
                    annotations: { title: t.title, readOnlyHint: t.readOnly, openWorldHint: true, ...(t.readOnly ? { destructiveHint: false } : {}) },
                })),
            })
        }
        case 'tools/call': {
            try {
                const response = await ask({ method: 'tool', name: params?.name, args: params?.arguments ?? {} }, id)
                if (!response.ok)
                    return reply(id, { content: [{ type: 'text', text: response.error }], isError: true })
                const content = [{ type: 'text', text: response.text ?? '' }]
                if (response.image)
                    content.push({ type: 'image', data: response.image.data, mimeType: response.image.mimeType })
                return reply(id, { content })
            }
            catch (error) {
                // A cancelled call gets no answer.
                if (error.message === 'cancelled')
                    return
                return reply(id, { content: [{ type: 'text', text: error.message }], isError: true })
            }
        }
        case 'notifications/cancelled':
            open.get(params?.requestId)?.destroy()
            return
        default:
            if (id !== undefined)
                fail(id, -32601, `method not found: ${method}`)
    }
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
    if (!line.trim())
        return
    let message
    try {
        message = JSON.parse(line)
    }
    catch {
        return
    }
    handle(message).catch(error => message.id !== undefined && fail(message.id, -32603, String(error?.message ?? error)))
})
// The agent closing our stdin is its way to stop us.
lines.on('close', () => process.exit(0))
