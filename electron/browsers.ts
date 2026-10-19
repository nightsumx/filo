// The Browser tool window's pages. A tab is a WebContentsView laid over the window's renderer where
// the panel is; the renderer only says where (`show`). Tabs belong to a project, as terminals do, and
// are either the user's or an agent session's. The agent drives them through browserTools.ts; the user
// sees and uses the same page, logged in as they are.
//
// A view that was never added to a window draws nothing, and then screenshots hang. So every tab joins
// its project's window when it is made and stays a child of one: hidden (not removed) when it is not
// the one shown, which keeps it drawing at its last size.
import type { BrowserBounds, BrowserKeyEvent, BrowserTabInfo } from '@shared/ipc'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, clipboard, Menu, session, WebContentsView } from 'electron'
import { allowedScheme, parseAddress } from './browserText'
import { PageDriver } from './browserDriver'
import { tr } from './i18n'

/** One cookie jar and storage for all projects, kept between runs: log in once, as in any browser. */
export const PARTITION = 'persist:filo-browser'

const DEFAULT_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 900, height: 640 }

export interface Tab {
    id: string
    cwd: string
    by: 'user' | 'agent'
    /** The pi session of an agent's tab; 'user' for the user's. */
    owner: string
    view: WebContentsView
    driver: PageDriver
    window: BrowserWindow
    /** Agent calls in flight on it. */
    busy: number
    createdAt: number
    visible: boolean
    /** Last time the user's panel showed it. */
    shownAt: number
    /** The tab whose page opened this one (window.open, target=_blank). */
    openedFrom?: string
}

export interface BrowsersOptions {
    /** The window showing a project. */
    windowOf: (cwd: string) => BrowserWindow | undefined
    onChange: (list: BrowserTabInfo[]) => void
    /** A key pressed inside a page that the app's window should hear, as if it were typed there. */
    onKey: (window: BrowserWindow, event: BrowserKeyEvent) => void
}

const rounded = (b: BrowserBounds): Electron.Rectangle => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) })

export class Browsers {
    private tabs = new Map<string, Tab>()
    /** `${cwd}\n${session}` → the tab an agent session works in (made on its first navigation). */
    private own = new Map<string, string>()
    /** Same key → a tab it chose with `tabs select`; wins over its own. */
    private chosen = new Map<string, string>()
    private bounds = DEFAULT_BOUNDS
    private notify: ReturnType<typeof setTimeout> | undefined
    private prune: ReturnType<typeof setTimeout> | undefined
    private ready = false

    constructor(private options: BrowsersOptions) {}

    private setup() {
        if (this.ready)
            return
        this.ready = true
        const ses = session.fromPartition(PARTITION)
        // Sites turn away "Electron/…" and the app's own name; the page is Chrome to them.
        ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Filo|filo)\/\S+/g, ''))
        // A page asks for the camera, location or notifications: no. Clipboard writes from clicks stay.
        ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'))
        ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
        // Downloads would land somewhere nobody chose; the agent and the user see a console line instead.
        ses.on('will-download', (_event, item, wc) => {
            item.cancel()
            const tab = [...this.tabs.values()].find(t => t.view.webContents.id === wc?.id)
            tab?.driver.note(`download blocked: ${item.getFilename()}`)
        })
    }

    // ------------------------------------------------------------ the list

    private info(tab: Tab): BrowserTabInfo {
        const wc = tab.view.webContents
        const url = wc.getURL()
        return {
            id: tab.id,
            cwd: tab.cwd,
            by: tab.by,
            url: url === 'about:blank' ? '' : url,
            title: wc.getTitle(),
            loading: wc.isLoading(),
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
            busy: tab.busy > 0,
            createdAt: tab.createdAt,
            ...(tab.openedFrom ? { openedFrom: tab.openedFrom } : {}),
        }
    }

    list(): BrowserTabInfo[] {
        return [...this.tabs.values()].filter(t => !t.view.webContents.isDestroyed()).map(t => this.info(t))
    }

    get(id: unknown): Tab | undefined {
        return typeof id === 'string' ? this.tabs.get(id) : undefined
    }

    /** Tells the windows, once for a burst of title, loading and navigation events. */
    private changed() {
        clearTimeout(this.notify)
        this.notify = setTimeout(() => this.options.onChange(this.list()), 40)
    }

    // ------------------------------------------------------------ making and closing

    create(cwd: string, by: 'user' | 'agent', owner: string, url?: string, openedFrom?: string): Tab {
        this.setup()
        const window = this.options.windowOf(cwd)
        if (!window || window.isDestroyed())
            throw new Error('no window shows this project')
        const view = new WebContentsView({
            webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
        })
        // Pages are written for a white canvas.
        view.setBackgroundColor('#ffffff')
        view.setBounds(rounded(this.bounds))
        view.setVisible(false)
        window.contentView.addChildView(view)
        const wc = view.webContents
        const tab: Tab = { id: randomUUID(), cwd, by, owner, view, driver: new PageDriver(wc), window, busy: 0, createdAt: Date.now(), visible: false, shownAt: 0, openedFrom }
        this.tabs.set(tab.id, tab)
        this.guard(tab)
        const changed = () => this.changed()
        wc.on('page-title-updated', changed)
        wc.on('did-navigate', changed)
        wc.on('did-navigate-in-page', changed)
        wc.on('did-start-loading', changed)
        wc.on('did-stop-loading', changed)
        wc.on('did-fail-load', changed)
        wc.once('destroyed', () => {
            this.tabs.delete(tab.id)
            for (const map of [this.own, this.chosen]) {
                for (const [key, id] of map) {
                    if (id === tab.id)
                        map.delete(key)
                }
            }
            this.changed()
        })
        if (url)
            void wc.loadURL(url).catch(() => {})
        this.changed()
        return tab
    }

    /** What a page may do besides drawing: no other schemes, no popups of its own, a menu on right click, app shortcuts that work. */
    private guard(tab: Tab) {
        const wc = tab.view.webContents
        wc.on('will-navigate', (event) => {
            if (!allowedScheme(event.url))
                event.preventDefault()
        })
        wc.on('will-redirect', (event) => {
            if (!allowedScheme(event.url))
                event.preventDefault()
        })
        // window.open and target=_blank become a tab of the same owner. (A login popup that talks back to its opener cannot work this way.)
        wc.setWindowOpenHandler(({ url }) => {
            if (allowedScheme(url) && url !== 'about:blank') {
                try {
                    this.create(tab.cwd, tab.by, tab.owner, url, tab.id)
                }
                catch {}
            }
            return { action: 'deny' }
        })
        wc.on('before-input-event', (_event, input) => {
            if (input.type === 'keyDown' && (input.control || input.meta))
                this.options.onKey(tab.window, { key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta, altKey: input.alt, shiftKey: input.shift })
        })
        wc.on('context-menu', (_event, params) => {
            const history = wc.navigationHistory
            const items: Electron.MenuItemConstructorOptions[] = []
            if (params.linkURL && allowedScheme(params.linkURL)) {
                items.push(
                    { label: tr('在新标签页打开链接', 'Open link in new tab'), click: () => this.create(tab.cwd, tab.by, tab.owner, params.linkURL, tab.id) },
                    { label: tr('复制链接地址', 'Copy link address'), click: () => clipboard.writeText(params.linkURL) },
                    { type: 'separator' },
                )
            }
            if (params.selectionText)
                items.push({ label: tr('复制', 'Copy'), role: 'copy' })
            if (params.isEditable)
                items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
            items.push(
                { label: tr('后退', 'Back'), enabled: history.canGoBack(), click: () => history.goBack() },
                { label: tr('前进', 'Forward'), enabled: history.canGoForward(), click: () => history.goForward() },
                { label: tr('重新载入', 'Reload'), click: () => wc.reload() },
                { type: 'separator' },
                { label: tr('检查元素', 'Inspect element'), click: () => wc.inspectElement(params.x, params.y) },
            )
            Menu.buildFromTemplate(items).popup({ window: tab.window })
        })
    }

    close(id: unknown) {
        const tab = this.get(id)
        if (!tab)
            return
        this.tabs.delete(tab.id)
        tab.driver.detach()
        const wc = tab.view.webContents
        try {
            if (!tab.window.isDestroyed())
                tab.window.contentView.removeChildView(tab.view)
        }
        catch {}
        if (!wc.isDestroyed())
            wc.close()
        this.changed()
    }

    closeAll() {
        for (const id of [...this.tabs.keys()])
            this.close(id)
    }

    /**
     * The projects windows show changed. Tabs of a project that moved to another window follow it; those
     * of a project no window shows go a moment later, so a project passing between windows keeps them.
     */
    reconcile(shown: Set<string>) {
        for (const tab of this.tabs.values()) {
            const window = this.options.windowOf(tab.cwd)
            if (window && window !== tab.window)
                this.move(tab, window)
        }
        clearTimeout(this.prune)
        this.prune = setTimeout(() => {
            for (const tab of [...this.tabs.values()]) {
                if (!shown.has(tab.cwd))
                    this.close(tab.id)
            }
        }, 2000)
    }

    private move(tab: Tab, window: BrowserWindow) {
        if (tab.window === window || window.isDestroyed())
            return
        try {
            if (!tab.window.isDestroyed())
                tab.window.contentView.removeChildView(tab.view)
        }
        catch {}
        window.contentView.addChildView(tab.view)
        tab.window = window
        tab.view.setVisible(tab.visible)
    }

    // ------------------------------------------------------------ the panel

    /**
     * The panel of `sender`'s window shows this tab at these bounds (window coordinates), or nothing.
     * Tabs of the window that are not the shown one are hidden.
     */
    show(sender: WebContents, id: string | null, bounds?: BrowserBounds) {
        const window = BrowserWindow.fromWebContents(sender)
        if (!window)
            return
        if (bounds && bounds.width > 0 && bounds.height > 0)
            this.bounds = bounds
        for (const tab of this.tabs.values()) {
            if (tab.id === id) {
                this.move(tab, window)
                if (bounds && bounds.width > 0 && bounds.height > 0)
                    tab.view.setBounds(rounded(bounds))
                if (!tab.visible) {
                    // Over the renderer and over whatever was shown before.
                    window.contentView.addChildView(tab.view)
                    tab.visible = true
                    tab.view.setVisible(true)
                }
                tab.shownAt = Date.now()
            }
            else if (tab.window === window && tab.visible) {
                tab.visible = false
                tab.view.setVisible(false)
            }
        }
    }

    /** The tab the user's panel showed last in a project: what "this page" means to an agent that has no tab of its own. */
    front(cwd: string): Tab | undefined {
        let best: Tab | undefined
        for (const tab of this.tabs.values()) {
            if (tab.cwd === cwd && tab.shownAt > 0 && (!best || tab.shownAt > best.shownAt))
                best = tab
        }
        return best
    }

    // ------------------------------------------------------------ the user

    navigate(id: unknown, input: string) {
        const tab = this.get(id)
        if (!tab)
            throw new Error('that tab is gone')
        void tab.view.webContents.loadURL(parseAddress(input, true)).catch(() => {})
    }

    go(id: unknown, action: 'back' | 'forward' | 'reload' | 'stop') {
        const wc = this.get(id)?.view.webContents
        if (!wc)
            return
        if (action === 'back')
            wc.navigationHistory.goBack()
        else if (action === 'forward')
            wc.navigationHistory.goForward()
        else if (action === 'reload')
            wc.reload()
        else
            wc.stop()
    }

    devTools(id: unknown) {
        this.get(id)?.view.webContents.openDevTools({ mode: 'detach' })
    }

    // ------------------------------------------------------------ agents

    private key(cwd: string, sessionId: string) {
        return `${cwd}\n${sessionId}`
    }

    /**
     * The tab an agent session's calls land in: the one it chose, else its own, else (when `create`)
     * a new one, else the one the user's panel shows. Nothing to land in is an error.
     */
    resolve(cwd: string, sessionId: string, create: boolean): Tab {
        const key = this.key(cwd, sessionId)
        const alive = (id: string | undefined) => (id ? this.tabs.get(id) : undefined)
        const found = alive(this.chosen.get(key)) ?? alive(this.own.get(key))
        if (found)
            return found
        if (create) {
            const tab = this.create(cwd, 'agent', sessionId)
            this.own.set(key, tab.id)
            return tab
        }
        const front = this.front(cwd)
        if (front)
            return front
        throw new Error('no browser page is open in this project; call browser_navigate with a URL first')
    }

    /** `tabs`: what the session's calls land in from now on. */
    choose(cwd: string, sessionId: string, id: string) {
        this.chosen.set(this.key(cwd, sessionId), id)
    }

    /** A fresh tab for a session, which becomes the one its calls land in. */
    open(cwd: string, sessionId: string, url?: string): Tab {
        const tab = this.create(cwd, 'agent', sessionId, url)
        this.chosen.set(this.key(cwd, sessionId), tab.id)
        return tab
    }

    isCurrent(cwd: string, sessionId: string, tab: Tab): boolean {
        try {
            return this.resolve(cwd, sessionId, false) === tab
        }
        catch {
            return false
        }
    }

    /** Marks the agent at work on a tab for as long as `work` runs, so the panel can say so. */
    async working<T>(tab: Tab, work: () => Promise<T>): Promise<T> {
        tab.busy++
        this.changed()
        try {
            return await work()
        }
        finally {
            tab.busy--
            this.changed()
        }
    }
}
