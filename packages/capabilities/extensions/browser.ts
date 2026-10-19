// browser: web pages in the desktop app's Browser tool window. The agent opens a page, reads it as an
// outline of its elements (browser_snapshot, each clickable thing with a ref), clicks, types, scrolls,
// looks at screenshots and the console. The user sees the same tab: they can watch, log in or solve a
// captcha themselves, and carry on from there.
//
// Talks to the app over the unix socket it names in PI_KIT_BROWSER (protocol.ts, BrowserCall); without
// the app (pi-cc-tui in a terminal) the tools are not registered. Each pi session works in a tab of its
// own, so two threads of one project never click in the same page.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { BrowserBody, BrowserCall, BrowserDetails, BrowserResponse } from '../protocol'
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
    const tabs = response.tabs?.map(t => `${t.id}  ${t.title || '(untitled)'} — ${t.url || 'blank'}${t.by === 'user' ? '  [opened by the user]' : ''}${t.current ? '  [your calls land here]' : ''}`)
    const text = response.text ?? (tabs ? (tabs.length ? `Tabs in this project:\n${tabs.join('\n')}` : 'No tabs in this project.') : '')
    const content: Content[] = [{ type: 'text', text }]
    if (response.image)
        content.push({ type: 'image', data: response.image.data, mimeType: response.image.mimeType })
    return { content, details: { kind: 'browser', ...(response.tab ? { tab: response.tab } : {}) } }
}

const seconds = (s: number | undefined) => (s === undefined ? undefined : Math.max(0, s) * 1000)
const ref = Type.String({ description: 'Element ref from browser_snapshot, like "e12"' })

export default function (pi: ExtensionAPI) {
    if (!process.env[SOCKET_ENV])
        return
    const readOnly = READ_ONLY_ENVS.some(name => process.env[name])
    const hints = { readOnlyHint: true }

    /** Registers a tool whose call becomes `build(params)` for the app. */
    function tool<P extends ReturnType<typeof Type.Object>>(spec: { name: string, label: string, description: string, parameters: P, readOnly?: true, first?: true, build: (params: any) => BrowserBody }) {
        if (readOnly && !spec.readOnly)
            return
        pi.registerTool({
            name: spec.name,
            label: spec.label,
            description: spec.description,
            ...(spec.first
                ? {
                        promptSnippet: 'Open, read and operate web pages in the app\'s Browser panel, where the user can watch and log in',
                        promptGuidelines: [
                            'Read a page with browser_snapshot and act on its elements by ref; use browser_screenshot when layout or looks matter. Refs change after a page loads: snapshot again.',
                            'After changing a web app, reload it with browser_navigate and check browser_console before saying it works.',
                            'For a login, captcha or payment, stop and ask the user to do it in the Browser panel, then go on.',
                        ],
                    }
                : {}),
            parameters: spec.parameters,
            ...(spec.readOnly ? { annotations: hints } : {}),
            async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
                const call: BrowserCall = { cwd: ctx.cwd, session: ctx.sessionManager.getSessionId(), ...spec.build(params) }
                return result(await request(call, signal))
            },
        })
    }

    tool({
        name: 'browser_navigate',
        label: 'Browser Navigate',
        description: 'Open a URL in this session\'s browser tab (made on first use), or go back, forward or reload. Returns the page as an outline of its elements. http, https and file URLs; localhost needs no scheme.',
        parameters: Type.Object({
            url: Type.Optional(Type.String({ description: 'e.g. localhost:5173, https://example.com, /abs/path/index.html' })),
            history: Type.Optional(Type.Union([Type.Literal('back'), Type.Literal('forward'), Type.Literal('reload')], { description: 'Instead of url' })),
            timeout: Type.Optional(Type.Number({ description: 'Seconds to wait for the load (default 20)' })),
        }),
        first: true,
        build: p => ({ method: 'navigate', url: p.url, history: p.history, timeoutMs: seconds(p.timeout) }),
    })

    tool({
        name: 'browser_snapshot',
        label: 'Browser Snapshot',
        description: 'The page as an outline: headings, text, links, fields and buttons. What can be clicked or typed into has a ref. With ref, only that part.',
        parameters: Type.Object({ ref: Type.Optional(ref) }),
        readOnly: true,
        build: p => ({ method: 'snapshot', ref: p.ref }),
    })

    tool({
        name: 'browser_screenshot',
        label: 'Browser Screenshot',
        description: 'A picture of the page as shown (or one element, or the whole page). Pixel positions in it are what browser_click x/y take.',
        parameters: Type.Object({
            ref: Type.Optional(ref),
            full_page: Type.Optional(Type.Boolean({ description: 'The whole page, not only what is visible' })),
        }),
        readOnly: true,
        build: p => ({ method: 'screenshot', ref: p.ref, fullPage: p.full_page }),
    })

    tool({
        name: 'browser_click',
        label: 'Browser Click',
        description: 'Click an element by ref, or a spot by x and y. Returns what changed on the page.',
        parameters: Type.Object({
            ref: Type.Optional(ref),
            x: Type.Optional(Type.Number({ description: 'Page pixels, with y, when there is no ref' })),
            y: Type.Optional(Type.Number()),
            button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])),
            double: Type.Optional(Type.Boolean({ description: 'Double click' })),
            hover: Type.Optional(Type.Boolean({ description: 'Only move the pointer there' })),
        }),
        build: p => ({ method: 'click', ref: p.ref, x: p.x, y: p.y, button: p.button, double: p.double, hover: p.hover }),
    })

    tool({
        name: 'browser_type',
        label: 'Browser Type',
        description: 'Type into a field by ref (replacing its text unless clear is false), or into whatever has focus. submit presses Enter after.',
        parameters: Type.Object({
            text: Type.String(),
            ref: Type.Optional(ref),
            clear: Type.Optional(Type.Boolean({ description: 'Replace the current text (default true)' })),
            submit: Type.Optional(Type.Boolean({ description: 'Press Enter afterwards' })),
        }),
        build: p => ({ method: 'type', ref: p.ref, text: p.text, clear: p.clear, submit: p.submit }),
    })

    tool({
        name: 'browser_press',
        label: 'Browser Press',
        description: 'Press a key or shortcut in the page: Enter, Escape, Tab, ArrowDown, PageDown, Control+A, Meta+Shift+Z, ControlOrMeta+K.',
        parameters: Type.Object({ key: Type.String() }),
        build: p => ({ method: 'press', key: p.key }),
    })

    tool({
        name: 'browser_select',
        label: 'Browser Select',
        description: 'Choose option(s) of a <select> by value or label.',
        parameters: Type.Object({ ref, values: Type.Array(Type.String()) }),
        build: p => ({ method: 'select', ref: p.ref, values: p.values }),
    })

    tool({
        name: 'browser_scroll',
        label: 'Browser Scroll',
        description: 'Scroll the page, or a scrollable element (ref), by dy pixels (default a screen); with ref and no dy, bring that element into view.',
        parameters: Type.Object({ ref: Type.Optional(ref), dy: Type.Optional(Type.Number({ description: 'Positive scrolls down' })), dx: Type.Optional(Type.Number()) }),
        readOnly: true,
        build: p => ({ method: 'scroll', ref: p.ref, dy: p.dy, dx: p.dx }),
    })

    tool({
        name: 'browser_wait',
        label: 'Browser Wait',
        description: 'Wait until text appears (or disappears) on the page, or for some seconds. Returns what changed.',
        parameters: Type.Object({
            text: Type.Optional(Type.String({ description: 'Wait for this text to appear' })),
            text_gone: Type.Optional(Type.String({ description: 'Wait for this text to disappear' })),
            seconds: Type.Optional(Type.Number({ description: 'Just wait this long' })),
            timeout: Type.Optional(Type.Number({ description: 'Give up after this many seconds (default 15, max 60)' })),
        }),
        readOnly: true,
        build: p => ({ method: 'wait', text: p.text, textGone: p.text_gone, ms: seconds(p.seconds), timeoutMs: seconds(p.timeout) }),
    })

    tool({
        name: 'browser_eval',
        label: 'Browser Eval',
        description: 'Run a JavaScript expression in the page (await allowed) and return its value as JSON: computed styles, storage, a fetch. Use it to read; click and type with the other tools.',
        parameters: Type.Object({ expression: Type.String() }),
        build: p => ({ method: 'eval', expression: p.expression }),
    })

    tool({
        name: 'browser_console',
        label: 'Browser Console',
        description: 'Console output, uncaught errors, failed requests and dialogs the page showed since you last asked.',
        parameters: Type.Object({}),
        readOnly: true,
        build: () => ({ method: 'console' }),
    })

    tool({
        name: 'browser_tabs',
        label: 'Browser Tabs',
        description: 'List the project\'s tabs (yours and the user\'s), select one to work in (e.g. the page the user has open), open a new one, or close one you opened.',
        parameters: Type.Object({
            action: Type.Union([Type.Literal('list'), Type.Literal('select'), Type.Literal('new'), Type.Literal('close')]),
            id: Type.Optional(Type.String({ description: 'Tab id, for select and close' })),
            url: Type.Optional(Type.String({ description: 'For new' })),
        }),
        build: p => ({ method: 'tabs', action: p.action, id: p.id, url: p.url }),
    })
}
