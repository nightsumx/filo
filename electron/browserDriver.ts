// Drives one page of the Browser tool window for the agent, over the Chrome DevTools protocol that
// Electron's `webContents.debugger` speaks: the page as an outline with refs, trusted mouse and
// keyboard input, screenshots, the console. The page is the user's too, so everything goes through
// real input events and nothing is injected into it (the click marker lives in an isolated world).
import type { WebContents } from 'electron'
import type { ConsoleLine } from './browserText'
import { platform } from './platform'
import { consoleLevel, formatConsole, parseKey, renderOutline } from './browserText'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A blue ring where the agent clicked, so the user can follow what it does. */
const MARKER = `(x, y) => {
    const d = document.createElement('div')
    Object.assign(d.style, { position: 'fixed', left: (x - 11) + 'px', top: (y - 11) + 'px', width: '22px', height: '22px', borderRadius: '50%', boxSizing: 'border-box', background: 'rgba(74,143,231,.28)', border: '2px solid rgba(74,143,231,.9)', pointerEvents: 'none', zIndex: '2147483647' })
    document.documentElement.appendChild(d)
    d.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 650, easing: 'ease-out' }).onfinish = () => d.remove()
}`
const MARKER_WORLD = 1999

const MAX_CONSOLE = 300
const MAX_EVAL_CHARS = 8000
const MAX_FULL_PAGE = 10_000

export interface Shot { data: string, mimeType: string }

export class PageDriver {
    private refByNode = new Map<number, number>()
    private nodeByRef = new Map<number, number>()
    /** Never reused, so a ref from before a navigation cannot point at another element later. */
    private nextRef = 1
    private console: ConsoleLine[] = []
    private unread = 0
    private status = 0
    /** The outline the agent saw last, to tell it when an action changed nothing. */
    private lastOutline = ''

    constructor(private wc: WebContents) {
        wc.on('console-message', (event) => {
            // Electron's own warning about the page's missing CSP, shown in development only.
            if (event.message.startsWith('%cElectron Security Warning'))
                return
            this.log({ level: consoleLevel(event.level), text: event.message, ...(event.sourceId ? { source: `${event.sourceId.split('/').pop()}:${event.lineNumber}` } : {}) })
        })
        wc.on('did-start-navigation', (event) => {
            if (event.isMainFrame && !event.isSameDocument)
                this.forget()
        })
        wc.on('did-navigate', (_event, _url, code) => {
            this.status = code
        })
        wc.debugger.on('message', (_event, method, params) => {
            // A dialog blocks the page until answered, and nobody is looking: alerts are read, questions are declined.
            if (method === 'Page.javascriptDialogOpening') {
                const accept = params.type === 'alert' || params.type === 'beforeunload'
                this.log({ level: 'dialog', text: `${params.type}: ${params.message} (${accept ? 'accepted' : 'dismissed'})` })
                void this.wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept }).catch(() => {})
            }
        })
    }

    private log(line: ConsoleLine) {
        this.console.push(line)
        if (this.console.length > MAX_CONSOLE) {
            const drop = this.console.length - MAX_CONSOLE
            this.console.splice(0, drop)
            this.unread = Math.max(0, this.unread - drop)
        }
    }

    /** A line for the console the agent reads, from the app (a blocked download). */
    note(text: string) {
        this.log({ level: 'info', text })
    }

    /** A new document: the old elements are gone, and so are their refs. */
    private forget() {
        this.refByNode.clear()
        this.nodeByRef.clear()
        this.lastOutline = ''
    }

    private async attach() {
        const dbg = this.wc.debugger
        if (dbg.isAttached())
            return
        dbg.attach('1.3')
        await Promise.all([
            dbg.sendCommand('Page.enable'),
            dbg.sendCommand('Accessibility.enable'),
            // The page believes it has focus although the app's own window may not (or the panel is closed).
            dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }),
        ])
    }

    private async send<T = any>(method: string, params?: object): Promise<T> {
        await this.attach()
        return this.wc.debugger.sendCommand(method, params)
    }

    detach() {
        if (this.wc.isDestroyed() || !this.wc.debugger.isAttached())
            return
        try {
            this.wc.debugger.detach()
        }
        catch {}
    }

    // ------------------------------------------------------------ the page as text

    private refOf = (node: number): string => {
        let n = this.refByNode.get(node)
        if (n === undefined) {
            n = this.nextRef++
            this.refByNode.set(node, n)
            this.nodeByRef.set(n, node)
        }
        return `e${n}`
    }

    private nodeOf(ref: string): number {
        const n = /^e(\d+)$/.exec(ref.trim())?.[1]
        const node = n ? this.nodeByRef.get(Number(n)) : undefined
        if (node === undefined)
            throw new Error(`there is no element ${ref} on this page; call browser_snapshot and use the refs it lists`)
        return node
    }

    /** CDP says "No node with given id" for an element the page has removed since. */
    private async onNode<T>(ref: string, action: (node: number) => Promise<T>): Promise<T> {
        const node = this.nodeOf(ref)
        try {
            return await action(node)
        }
        catch (error: any) {
            if (/node|object id|context/i.test(String(error?.message)))
                throw new Error(`${ref} is no longer on the page (${String(error.message).trim()}); call browser_snapshot for the current refs`)
            throw error
        }
    }

    pageLine(): string {
        const url = this.wc.getURL()
        return `Page: ${this.wc.getTitle() || '(untitled)'} — ${url === 'about:blank' ? 'about:blank' : url}`
    }

    async snapshot(ref?: string): Promise<string> {
        const from = ref ? this.nodeOf(ref) : undefined
        const { nodes } = await this.send('Accessibility.getFullAXTree')
        const outline = renderOutline(nodes, { refOf: this.refOf, from })
        if (from !== undefined && !outline.text)
            throw new Error(`${ref} is no longer on the page; call browser_snapshot for the current refs`)
        const text = outline.text || '(the page has nothing to show yet)'
        this.lastOutline = text
        return outline.truncated ? `${text}\n… the page goes on; scroll down and snapshot again, or snapshot a part of it with ref` : text
    }

    /** The outline after an action, or a line saying nothing visible changed. */
    async changes(): Promise<string> {
        const before = this.lastOutline
        const outline = await this.snapshot()
        return before && outline === before ? '(no visible change)' : outline
    }

    // ------------------------------------------------------------ navigation

    /** Loads the page and waits for it; a page that is slow still comes back, and says so. */
    async navigate(url: string, timeoutMs: number): Promise<string[]> {
        this.status = 0
        const notes: string[] = []
        const load = this.wc.loadURL(url).then(() => 'loaded' as const, (error: any) => {
            // -3: superseded by another navigation, or turned into a download.
            if (error?.code === 'ERR_ABORTED' || error?.errno === -3)
                return 'aborted' as const
            const text = String(error?.message ?? error)
            const hint = /CONNECTION_REFUSED/.test(text) ? ' Nothing listens there; is the dev server running?' : ''
            throw new Error(`could not load ${url}: ${text.replace(/ loading '.*'$/, '')}.${hint}`)
        })
        const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
        const outcome = await Promise.race([load, timeout])
        if (outcome === 'timeout')
            notes.push(`still loading after ${Math.round(timeoutMs / 1000)}s; showing what has arrived`)
        if (outcome === 'aborted')
            notes.push('the navigation was cancelled (a download, or another page took over)')
        await this.settle()
        if (this.status >= 400)
            notes.push(`the server answered HTTP ${this.status}`)
        return notes
    }

    async history(action: 'back' | 'forward' | 'reload'): Promise<string[]> {
        const nav = this.wc.navigationHistory
        if (action === 'back' && !nav.canGoBack())
            throw new Error('there is no earlier page in this tab')
        if (action === 'forward' && !nav.canGoForward())
            throw new Error('there is no later page in this tab')
        if (action === 'back')
            nav.goBack()
        else if (action === 'forward')
            nav.goForward()
        else
            this.wc.reload()
        await this.settle()
        return []
    }

    /** After something that may navigate or load: waits for it to finish, then a moment for scripts to react. */
    async settle(maxMs = 10_000) {
        await sleep(200)
        const end = Date.now() + maxMs
        while (this.wc.isLoading() && Date.now() < end)
            await sleep(100)
        await sleep(150)
    }

    // ------------------------------------------------------------ input

    private async viewport(): Promise<{ width: number, height: number, x: number, y: number }> {
        const m = await this.send('Page.getLayoutMetrics')
        const v = m.cssVisualViewport
        return { width: v.clientWidth, height: v.clientHeight, x: v.pageX, y: v.pageY }
    }

    /** Scrolls the element into view and returns the middle of it, in the viewport. */
    private async center(node: number): Promise<{ x: number, y: number }> {
        try {
            await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node })
        }
        catch (error: any) {
            if (/layout object|not visible/i.test(String(error?.message)))
                throw new Error('that element is not visible (hidden, collapsed or zero-sized)')
            throw error
        }
        const { quads } = await this.send('DOM.getContentQuads', { backendNodeId: node })
        const quad: number[] | undefined = quads?.[0]
        if (!quad || quad.length < 8)
            throw new Error('that element is not visible (hidden, collapsed or zero-sized)')
        const view = await this.viewport()
        const clamp = (v: number, max: number) => Math.min(Math.max(v, 1), Math.max(1, max - 1))
        return { x: clamp((quad[0] + quad[2] + quad[4] + quad[6]) / 4, view.width), y: clamp((quad[1] + quad[3] + quad[5] + quad[7]) / 4, view.height) }
    }

    private async call(node: number, functionDeclaration: string, args: unknown[] = []): Promise<unknown> {
        const { object } = await this.send('DOM.resolveNode', { backendNodeId: node, objectGroup: 'filo' })
        try {
            const result = await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true })
            if (result.exceptionDetails)
                throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).split('\n')[0].replace(/^Error: /, ''))
            return result.result?.value
        }
        finally {
            void this.send('Runtime.releaseObjectGroup', { objectGroup: 'filo' }).catch(() => {})
        }
    }

    /** Something else lies over the element at its middle (a cookie banner, a modal): the click would land there. */
    private async coveredBy(node: number, x: number, y: number): Promise<string> {
        const covering = await this.call(node, `function (x, y) {
            const t = document.elementFromPoint(x, y)
            if (!t) return ''
            const up = (a, b) => { for (let n = a; n; n = n.parentNode || n.host) if (n === b) return true; return false }
            if (up(t, this) || up(this, t)) return ''
            const cls = typeof t.className === 'string' && t.className.trim() ? '.' + t.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
            return t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + cls
        }`, [x, y]).catch(() => '')
        return typeof covering === 'string' ? covering : ''
    }

    private marker(x: number, y: number) {
        void this.wc.executeJavaScriptInIsolatedWorld(MARKER_WORLD, [{ code: `(${MARKER})(${x}, ${y})` }]).catch(() => {})
    }

    async click(o: { ref?: string, x?: number, y?: number, button?: 'left' | 'right' | 'middle', double?: boolean, hover?: boolean }): Promise<string[]> {
        const notes: string[] = []
        let x: number
        let y: number
        if (o.ref) {
            const target = await this.onNode(o.ref, async (node) => {
                const point = await this.center(node)
                const over = await this.coveredBy(node, point.x, point.y)
                if (over)
                    notes.push(`the middle of ${o.ref} is covered by <${over}>, so the click landed there; close what covers it, or scroll`)
                return point
            })
            x = target.x
            y = target.y
        }
        else if (typeof o.x === 'number' && typeof o.y === 'number') {
            x = o.x
            y = o.y
        }
        else {
            throw new Error('give a ref from browser_snapshot, or x and y in page pixels (as in a browser_screenshot)')
        }
        this.marker(x, y)
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        if (o.hover)
            return notes
        const button = o.button ?? 'left'
        const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4
        for (let count = 1; count <= (o.double ? 2 : 1); count++) {
            await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: count })
            await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: count })
        }
        await this.settle(5000)
        return notes
    }

    async type(o: { ref?: string, text: string, clear: boolean, submit: boolean }) {
        if (o.ref) {
            await this.onNode(o.ref, async (node) => {
                const point = await this.center(node)
                this.marker(point.x, point.y)
                await this.send('DOM.focus', { backendNodeId: node })
                // Replaces what is there (clear), or goes after it.
                await this.call(node, `function (clear) {
                    this.focus()
                    try {
                        const range = () => { const r = document.createRange(); r.selectNodeContents(this); return r }
                        const select = (r) => { const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
                        if (clear) {
                            if (typeof this.select === 'function') this.select()
                            else select(range())
                        }
                        else if (this.isContentEditable) {
                            const r = range(); r.collapse(false); select(r)
                        }
                        else if (typeof this.setSelectionRange === 'function') {
                            const n = this.value.length; this.setSelectionRange(n, n)
                        }
                    }
                    catch {}
                }`, [o.clear])
            })
        }
        if (o.text)
            await this.send('Input.insertText', { text: o.text })
        else if (o.clear)
            await this.key('Backspace')
        if (o.submit)
            await this.key('Enter')
        await this.settle(o.submit ? 5000 : 300)
    }

    private async key(spec: string) {
        const press = parseKey(spec, platform.id === 'darwin')
        const base = { key: press.key, code: press.code, windowsVirtualKeyCode: press.windowsVirtualKeyCode, modifiers: press.modifiers }
        await this.send('Input.dispatchKeyEvent', { ...base, type: press.text ? 'keyDown' : 'rawKeyDown', ...(press.text ? { text: press.text } : {}), ...(press.commands ? { commands: press.commands } : {}) })
        await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    }

    async press(spec: string) {
        await this.key(spec)
        await this.settle(spec.toLowerCase().endsWith('enter') ? 5000 : 300)
    }

    async select(ref: string, values: string[]): Promise<string> {
        const chosen = await this.onNode(ref, node => this.call(node, `function (values) {
            if (this.tagName !== 'SELECT') throw new Error('that is not a <select>; click it and pick the option instead')
            let hits = 0
            for (const o of this.options) {
                const hit = values.includes(o.value) || values.includes(o.label) || values.includes(o.text.trim())
                o.selected = hit
                if (hit) hits++
            }
            if (!hits) throw new Error('no option matches; the options are ' + [...this.options].map(o => JSON.stringify(o.label)).join(', '))
            this.dispatchEvent(new Event('input', { bubbles: true }))
            this.dispatchEvent(new Event('change', { bubbles: true }))
            return [...this.selectedOptions].map(o => o.label)
        }`, [values]))
        await this.settle(300)
        return Array.isArray(chosen) ? chosen.join(', ') : ''
    }

    async scroll(o: { ref?: string, dx?: number, dy?: number }): Promise<string> {
        const wheel = (o.dx ?? 0) !== 0 || (o.dy ?? 0) !== 0
        const view = await this.viewport()
        let at = { x: view.width / 2, y: view.height / 2 }
        if (o.ref)
            at = await this.onNode(o.ref, node => this.center(node))
        if (wheel || !o.ref) {
            const deltaY = wheel ? o.dy ?? 0 : Math.round(view.height * 0.8)
            await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: o.dx ?? 0, deltaY })
        }
        await sleep(350)
        const pos = await this.evaluate('JSON.stringify({ y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) })')
        const { y, max } = JSON.parse(pos)
        return `Scrolled to ${y}px of ${max}px${y >= max ? ' (bottom)' : y === 0 ? ' (top)' : ''}`
    }

    // ------------------------------------------------------------ reading

    async screenshot(o: { ref?: string, fullPage?: boolean }): Promise<Shot> {
        const view = await this.viewport()
        let clip = { x: view.x, y: view.y, width: view.width, height: view.height, scale: 1 }
        let beyond = false
        if (o.ref) {
            clip = await this.onNode(o.ref, async (node) => {
                await this.center(node)
                const { quads } = await this.send('DOM.getContentQuads', { backendNodeId: node })
                const q: number[] = quads[0]
                const xs = [q[0], q[2], q[4], q[6]]
                const ys = [q[1], q[3], q[5], q[7]]
                const v = await this.viewport()
                const x = Math.min(...xs)
                const y = Math.min(...ys)
                return { x: v.x + x, y: v.y + y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y), scale: 1 }
            })
        }
        else if (o.fullPage) {
            const m = await this.send('Page.getLayoutMetrics')
            clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, MAX_FULL_PAGE), scale: 1 }
            beyond = true
        }
        const png = await this.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: beyond })
        // A busy page makes a big PNG; the model gets a JPEG then.
        if (png.data.length > 1_500_000) {
            const jpeg = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip, captureBeyondViewport: beyond })
            return { data: jpeg.data, mimeType: 'image/jpeg' }
        }
        return { data: png.data, mimeType: 'image/png' }
    }

    async evaluate(expression: string): Promise<string> {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true })
        if (r.exceptionDetails)
            throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n').slice(0, 4).join('\n'))
        const value = r.result
        if (value.type === 'undefined')
            return 'undefined'
        const text = 'value' in value ? (typeof value.value === 'string' ? value.value : JSON.stringify(value.value, null, 2)) : String(value.description ?? value.type)
        return text.length > MAX_EVAL_CHARS ? `${text.slice(0, MAX_EVAL_CHARS)}\n… (${text.length - MAX_EVAL_CHARS} more characters)` : text
    }

    async wait(o: { text?: string, textGone?: string, ms?: number, timeoutMs: number }): Promise<string> {
        if (o.ms !== undefined && !o.text && !o.textGone) {
            await sleep(Math.min(o.ms, o.timeoutMs))
            return `Waited ${Math.round(Math.min(o.ms, o.timeoutMs) / 100) / 10}s.`
        }
        const end = Date.now() + o.timeoutMs
        const probe = `document.body ? document.body.innerText : ''`
        for (;;) {
            const body = await this.evaluate(probe).catch(() => '')
            if (o.text && body.includes(o.text))
                return `"${o.text}" appeared.`
            if (o.textGone && !body.includes(o.textGone))
                return `"${o.textGone}" is gone.`
            if (Date.now() >= end)
                throw new Error(o.text ? `"${o.text}" did not appear within ${Math.round(o.timeoutMs / 1000)}s` : `"${o.textGone}" was still there after ${Math.round(o.timeoutMs / 1000)}s`)
            await sleep(250)
        }
    }

    /** Console lines since the last time, including uncaught errors and failed requests. */
    readConsole(): string {
        const lines = this.console.slice(this.unread).filter(l => l.level !== 'debug')
        this.unread = this.console.length
        return lines.length ? formatConsole(lines) : '(nothing new in the console)'
    }
}
