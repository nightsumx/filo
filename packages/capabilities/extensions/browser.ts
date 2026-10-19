// browser: web pages in the desktop app's Browser tool window. The agent opens a page, reads it as an
// outline of its elements (browser_snapshot, each clickable thing with a ref), clicks, types, scrolls,
// looks at screenshots and the console. The user sees the same tab: they can watch, log in or solve a
// captcha themselves, and carry on from there.
//
// Talks to the app over the unix socket it names in PI_KIT_BROWSER (protocol.ts, BrowserCall); without
// the app (pi-cc-tui in a terminal) the tools are not registered. Each pi session works in a tab of its
// own, so two threads of one project never click in the same page.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { BrowserCall, BrowserDetails, BrowserResponse } from '../protocol'
import { BROWSER_GUIDELINES, BROWSER_SNIPPET, BROWSER_TOOLS } from '../lib/browserSpec'
import net from 'node:net'
import { Type } from 'typebox'

const SOCKET_ENV = 'PI_KIT_BROWSER'
const TOKEN_ENV = 'PI_KIT_BROWSER_TOKEN'
/** Read-only helper processes (review, autopilot) may look at a page but not act in it. */
const READ_ONLY_ENVS = ['PI_KIT_REVIEWER', 'PI_KIT_AUTOPILOT_SUPERVISOR', 'PI_KIT_AUTOPILOT_LEARNER']

/** One request per connection; an aborted tool call drops the connection (the page stays as it is). */
function request(body: BrowserCall, signal?: AbortSignal): Promise<BrowserResponse> {
    const socketPath = process.env[SOCKET_ENV]!
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath)
        let buffer = ''
        const abort = () => {
            socket.destroy()
            reject(new Error('aborted'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        socket.setEncoding('utf8')
        socket.on('connect', () => socket.write(`${JSON.stringify({ ...body, token: process.env[TOKEN_ENV] ?? '' })}\n`))
        socket.on('data', (chunk: string) => {
            buffer += chunk
        })
        socket.on('end', () => {
            signal?.removeEventListener('abort', abort)
            try {
                resolve(JSON.parse(buffer))
            }
            catch {
                reject(new Error('the app sent no answer'))
            }
        })
        socket.on('error', (error) => {
            signal?.removeEventListener('abort', abort)
            reject(new Error(`the app's browser is not reachable (${error.message})`))
        })
    })
}

type Content = { type: 'text', text: string } | { type: 'image', data: string, mimeType: string }
type Result = { content: Content[], details: BrowserDetails, isError?: boolean }

function result(response: BrowserResponse): Result {
    if (!response.ok)
        return { content: [{ type: 'text', text: response.error }], details: { kind: 'browser' }, isError: true }
    const text = response.text ?? ''
    const content: Content[] = [{ type: 'text', text }]
    if (response.image)
        content.push({ type: 'image', data: response.image.data, mimeType: response.image.mimeType })
    return { content, details: { kind: 'browser', ...(response.tab ? { tab: response.tab } : {}) } }
}


export default function (pi: ExtensionAPI) {
    if (!process.env[SOCKET_ENV])
        return
    const readOnly = READ_ONLY_ENVS.some(name => process.env[name])
    BROWSER_TOOLS.forEach((spec, index) => {
        // Helper processes (review, autopilot) may look at a page but not act in it.
        if (readOnly && !spec.readOnly)
            return
        pi.registerTool({
            name: spec.name,
            label: spec.label,
            description: spec.description,
            ...(index === 0 ? { promptSnippet: BROWSER_SNIPPET, promptGuidelines: BROWSER_GUIDELINES } : {}),
            parameters: Type.Unsafe(spec.parameters),
            ...(spec.readOnly ? { annotations: { readOnlyHint: true } } : {}),
            async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
                const call: BrowserCall = { cwd: ctx.cwd, session: ctx.sessionManager.getSessionId(), ...spec.build(params) }
                return result(await request(call, signal))
            },
        })
    })
}
