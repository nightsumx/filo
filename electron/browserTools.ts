// The agent's side of the Browser tool window: pi's browser capability (packages/capabilities/
// extensions/browser.ts) connects to this unix socket to open pages in app tabs, read them, and click
// and type in them. The user sees the same tab, so they can watch, log in, or take over.
//
// Only pi processes the app starts get the socket path and token (ENV.browser / browserToken).
import type { BrowserCall, BrowserRequest, BrowserResponse, BrowserTabSummary } from '@shared/capabilities'
import type { Browsers, Tab } from './browsers'
import { ENV } from '@shared/capabilities'
import path from 'node:path'
import { parseAddress } from './browserText'
import { projectOf, ToolSocket } from './toolSocket'

type Ok = Extract<BrowserResponse, { ok: true }>

const NAVIGATE_MS = 20_000
const MAX_NAVIGATE_MS = 120_000
const WAIT_MS = 15_000
const MAX_WAIT_MS = 60_000

const bounded = (ms: unknown, fallback: number, max: number) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.min(max, ms) : fallback
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : ''
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined

export class BrowserTools {
    private socket: ToolSocket<BrowserRequest, BrowserResponse>

    /** `projects`: folders the windows show; a request's cwd is matched to one of them. */
    constructor(private browsers: Browsers, readonly socketPath: string, private projects: () => Iterable<string> = () => []) {
        this.socket = new ToolSocket(socketPath, request => this.handle(request), { socket: ENV.browser, token: ENV.browserToken })
    }

    get token() {
        return this.socket.token
    }

    start() {
        return this.socket.start()
    }

    env() {
        return this.socket.env()
    }

    stop() {
        this.socket.stop()
    }

    private summary(tab: Tab, current?: boolean): BrowserTabSummary {
        const wc = tab.view.webContents
        return { id: tab.id, url: wc.getURL(), title: wc.getTitle(), by: tab.by, ...(current ? { current: true } : {}) }
    }

    async handle(call: BrowserCall): Promise<BrowserResponse> {
        if (typeof call.cwd !== 'string' || !path.isAbsolute(call.cwd))
            throw new Error('cwd must be an absolute path')
        const cwd = projectOf(call.cwd, this.projects())
        const session = text(call.session, 200) || 'unknown'
        const { browsers } = this

        if (call.method === 'tabs')
            return this.tabs(cwd, session, call)

        const tab = call.method === 'navigate' && !call.history ? browsers.resolve(cwd, session, true) : browsers.resolve(cwd, session, false)
        const driver = tab.driver
        const reply = (body: string, notes: string[] = []): Ok => ({
            ok: true,
            tab: this.summary(tab, true),
            text: [driver.pageLine(), ...notes.map(n => `Note: ${n}`), ...(body ? ['', body] : [])].join('\n'),
        })

        return browsers.working(tab, async (): Promise<BrowserResponse> => {
            switch (call.method) {
                case 'navigate': {
                    const notes = call.history
                        ? await driver.history(call.history)
                        : await driver.navigate(parseAddress(text(call.url, 4000)), bounded(call.timeoutMs, NAVIGATE_MS, MAX_NAVIGATE_MS))
                    return reply(await driver.snapshot(), notes)
                }
                case 'snapshot':
                    return reply(await driver.snapshot(text(call.ref, 20) || undefined))
                case 'screenshot':
                    return { ...reply(''), image: await driver.screenshot({ ref: text(call.ref, 20) || undefined, fullPage: call.fullPage === true }) }
                case 'click': {
                    const notes = await driver.click({
                        ref: text(call.ref, 20) || undefined,
                        x: finite(call.x),
                        y: finite(call.y),
                        button: call.button === 'right' || call.button === 'middle' ? call.button : 'left',
                        double: call.double === true,
                        hover: call.hover === true,
                    })
                    return reply(await driver.changes(), notes)
                }
                case 'type': {
                    await driver.type({ ref: text(call.ref, 20) || undefined, text: text(call.text, 100_000), clear: call.clear !== false, submit: call.submit === true })
                    return reply(await driver.changes())
                }
                case 'press':
                    await driver.press(text(call.key, 100))
                    return reply(await driver.changes())
                case 'select': {
                    const values = Array.isArray(call.values) ? call.values.filter((v): v is string => typeof v === 'string').slice(0, 50) : []
                    if (!values.length)
                        throw new Error('values is empty')
                    const chosen = await driver.select(text(call.ref, 20), values)
                    return reply(`Selected: ${chosen}`)
                }
                case 'scroll':
                    return reply(await driver.scroll({ ref: text(call.ref, 20) || undefined, dx: finite(call.dx), dy: finite(call.dy) }))
                case 'wait': {
                    const timeoutMs = bounded(call.timeoutMs, WAIT_MS, MAX_WAIT_MS)
                    const waited = await driver.wait({ text: text(call.text, 500) || undefined, textGone: text(call.textGone, 500) || undefined, ms: finite(call.ms), timeoutMs })
                    return reply(`${waited}\n\n${await driver.changes()}`)
                }
                case 'eval': {
                    const expression = text(call.expression, 100_000)
                    if (!expression.trim())
                        throw new Error('expression is empty')
                    return reply(await driver.evaluate(expression))
                }
                case 'console':
                    return reply(driver.readConsole())
            }
        })
    }

    private async tabs(cwd: string, session: string, call: Extract<BrowserCall, { method: 'tabs' }>): Promise<BrowserResponse> {
        const { browsers } = this
        const inProject = browsers.list().filter(t => t.cwd === cwd)
        const summaries = () => inProject.flatMap((info) => {
            const tab = browsers.get(info.id)
            return tab ? [this.summary(tab, browsers.isCurrent(cwd, session, tab))] : []
        })
        if (call.action === 'list')
            return { ok: true, tabs: summaries() }

        if (call.action === 'new') {
            const tab = browsers.open(cwd, session)
            const url = text(call.url, 4000)
            const notes = url ? await browsers.working(tab, () => tab.driver.navigate(parseAddress(url), NAVIGATE_MS)) : []
            return { ok: true, tab: this.summary(tab, true), text: [tab.driver.pageLine(), ...notes.map(n => `Note: ${n}`), '', url ? await tab.driver.snapshot() : 'A new blank tab; your next calls land here.'].join('\n') }
        }

        const tab = browsers.get(call.id)
        if (!tab || tab.cwd !== cwd)
            throw new Error(`no tab ${String(call.id)} in this project; call browser_tabs with action "list"`)
        if (call.action === 'select') {
            browsers.choose(cwd, session, tab.id)
            return { ok: true, tab: this.summary(tab, true), text: `Your next calls land in ${tab.id}${tab.by === 'user' ? ' (a tab the user opened)' : ''}.` }
        }
        if (tab.by !== 'agent')
            throw new Error('that tab belongs to the user; only tabs opened by browser_navigate or browser_tabs can be closed')
        browsers.close(tab.id)
        return { ok: true, text: `Closed ${tab.id}.` }
    }
}
