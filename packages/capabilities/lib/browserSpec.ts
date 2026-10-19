// The browser tools, once: their names, descriptions, parameters (plain JSON Schema) and how a call
// becomes a BrowserBody for the app. pi's extension (extensions/browser.ts) registers them from this,
// the app's MCP server (mcp/browser.mjs, for Codex, Claude Code and the ACP agents) lists the same
// ones, and the app turns a call into a request with `bodyOf`. So every agent sees the same tools.
import type { BrowserBody } from '../protocol'

type Schema = Record<string, unknown>

export interface BrowserToolSpec {
    name: string
    label: string
    description: string
    /** Looks at the page or moves around in it; changes nothing the page would keep. */
    readOnly?: true
    parameters: Schema
    /** Request for the app from the call's arguments. */
    build: (params: any) => BrowserBody
}

const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) })
const num = (description?: string): Schema => ({ type: 'number', ...(description ? { description } : {}) })
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) })
const oneOf = (values: string[], description?: string): Schema => ({ type: 'string', enum: values, ...(description ? { description } : {}) })
const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) })

const ref = str('Element ref from browser_snapshot, like "e12"')
const seconds = (s: number | undefined) => (s === undefined ? undefined : Math.max(0, s) * 1000)

/** What the model is told about working in the browser, once per session. */
export const BROWSER_SNIPPET = 'Open, read and operate web pages in the app\'s Browser panel, where the user can watch and log in'
export const BROWSER_GUIDELINES = [
    'Read a page with browser_snapshot and act on its elements by ref; use browser_screenshot when layout or looks matter. Refs change after a page loads: snapshot again.',
    'After changing a web app, reload it with browser_navigate and check browser_console before saying it works.',
    'For a login, captcha or payment, stop and ask the user to do it in the Browser panel, then go on.',
]

export const BROWSER_TOOLS: BrowserToolSpec[] = [
    {
        name: 'browser_navigate',
        label: 'Browser Navigate',
        description: 'Open a URL in this session\'s browser tab (made on first use), or go back, forward or reload. Returns the page as an outline of its elements. http, https and file URLs; localhost needs no scheme.',
        parameters: object({
            url: str('e.g. localhost:5173, https://example.com, /abs/path/index.html'),
            history: oneOf(['back', 'forward', 'reload'], 'Instead of url'),
            timeout: num('Seconds to wait for the load (default 20)'),
        }),
        build: p => ({ method: 'navigate', url: p.url, history: p.history, timeoutMs: seconds(p.timeout) }),
    },
    {
        name: 'browser_snapshot',
        label: 'Browser Snapshot',
        description: 'The page as an outline: headings, text, links, fields and buttons. What can be clicked or typed into has a ref. With ref, only that part.',
        readOnly: true,
        parameters: object({ ref }),
        build: p => ({ method: 'snapshot', ref: p.ref }),
    },
    {
        name: 'browser_screenshot',
        label: 'Browser Screenshot',
        description: 'A picture of the page as shown (or one element, or the whole page). Pixel positions in it are what browser_click x/y take.',
        readOnly: true,
        parameters: object({ ref, full_page: bool('The whole page, not only what is visible') }),
        build: p => ({ method: 'screenshot', ref: p.ref, fullPage: p.full_page }),
    },
    {
        name: 'browser_click',
        label: 'Browser Click',
        description: 'Click an element by ref, or a spot by x and y. Returns what changed on the page.',
        parameters: object({
            ref,
            x: num('Page pixels, with y, when there is no ref'),
            y: num(),
            button: oneOf(['left', 'right', 'middle']),
            double: bool('Double click'),
            hover: bool('Only move the pointer there'),
        }),
        build: p => ({ method: 'click', ref: p.ref, x: p.x, y: p.y, button: p.button, double: p.double, hover: p.hover }),
    },
    {
        name: 'browser_type',
        label: 'Browser Type',
        description: 'Type into a field by ref (replacing its text unless clear is false), or into whatever has focus. submit presses Enter after.',
        parameters: object({
            text: str(),
            ref,
            clear: bool('Replace the current text (default true)'),
            submit: bool('Press Enter afterwards'),
        }, ['text']),
        build: p => ({ method: 'type', ref: p.ref, text: p.text, clear: p.clear, submit: p.submit }),
    },
    {
        name: 'browser_press',
        label: 'Browser Press',
        description: 'Press a key or shortcut in the page: Enter, Escape, Tab, ArrowDown, PageDown, Control+A, Meta+Shift+Z, ControlOrMeta+K.',
        parameters: object({ key: str() }, ['key']),
        build: p => ({ method: 'press', key: p.key }),
    },
    {
        name: 'browser_select',
        label: 'Browser Select',
        description: 'Choose option(s) of a <select> by value or label.',
        parameters: object({ ref, values: { type: 'array', items: str() } }, ['ref', 'values']),
        build: p => ({ method: 'select', ref: p.ref, values: p.values }),
    },
    {
        name: 'browser_scroll',
        label: 'Browser Scroll',
        description: 'Scroll the page, or a scrollable element (ref), by dy pixels (default a screen); with ref and no dy, bring that element into view.',
        readOnly: true,
        parameters: object({ ref, dy: num('Positive scrolls down'), dx: num() }),
        build: p => ({ method: 'scroll', ref: p.ref, dy: p.dy, dx: p.dx }),
    },
    {
        name: 'browser_wait',
        label: 'Browser Wait',
        description: 'Wait until text appears (or disappears) on the page, or for some seconds. Returns what changed.',
        readOnly: true,
        parameters: object({
            text: str('Wait for this text to appear'),
            text_gone: str('Wait for this text to disappear'),
            seconds: num('Just wait this long'),
            timeout: num('Give up after this many seconds (default 15, max 60)'),
        }),
        build: p => ({ method: 'wait', text: p.text, textGone: p.text_gone, ms: seconds(p.seconds), timeoutMs: seconds(p.timeout) }),
    },
    {
        name: 'browser_eval',
        label: 'Browser Eval',
        description: 'Run a JavaScript expression in the page (await allowed) and return its value as JSON: computed styles, storage, a fetch. Use it to read; click and type with the other tools.',
        parameters: object({ expression: str() }, ['expression']),
        build: p => ({ method: 'eval', expression: p.expression }),
    },
    {
        name: 'browser_console',
        label: 'Browser Console',
        description: 'Console output, uncaught errors, failed requests and dialogs the page showed since you last asked.',
        readOnly: true,
        parameters: object(),
        build: () => ({ method: 'console' }),
    },
    {
        name: 'browser_tabs',
        label: 'Browser Tabs',
        description: 'List the project\'s tabs (yours and the user\'s), select one to work in (e.g. the page the user has open), open a new one, or close one you opened.',
        parameters: object({
            action: oneOf(['list', 'select', 'new', 'close']),
            id: str('Tab id, for select and close'),
            url: str('For new'),
        }, ['action']),
        build: p => ({ method: 'tabs', action: p.action, id: p.id, url: p.url }),
    },
]

/** The request for a tool call, or undefined for a name that is no browser tool. */
export function bodyOf(name: string, args: unknown): BrowserBody | undefined {
    const spec = BROWSER_TOOLS.find(t => t.name === name)
    return spec?.build(args && typeof args === 'object' ? args : {})
}
