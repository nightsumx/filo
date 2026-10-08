// One project per window, as in WebStorm. A window can also hold several projects after the user
// merges windows (or attaches a project); its project tree then lists them all. Projects move between
// windows live: the source window hands over its threads' state and main re-routes their pi
// processes, holding back events until the target window has taken them. Single tabs move the same
// way (dragged to another window or torn off), so one project can show in several windows; a session
// is still a tab in one window only.
import type { AppState, OpenProject, ProjectActivity, ProjectTransfer, StateSave, TabMove, ThreadTransfer, WindowBounds, WindowInit, WindowReport } from '@shared/ipc'
import type { StateFile } from './appState'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import { unionTabs, windowState } from './appState'
import { reveal } from './background'
import { tr } from './i18n'

interface Entry {
    win: BrowserWindow
    /** webContents id; stable for the window's life and what IPC senders are matched by. */
    id: number
    projects: string[]
    active: string | null
    activity: Record<string, ProjectActivity>
    ready: Promise<void>
    markReady: () => void
    /** Closed by the app (emptied by a transfer, or its last project closed): no prompt. */
    closing: boolean
    /** This window's tabs per project, as it last saved them (or as saved at the last quit). */
    tabs: Record<string, string[]>
    activeTabs: Record<string, string>
    /** Last time the window had focus: picks the window to bring forward for a project shown in several. */
    focusedAt: number
}

interface Route {
    /** Owning window (webContents id). */
    owner: number
    cwd: string
    /** Set while the project is moving: events wait here until the target window has its threads. */
    held: [channel: string, args: unknown[]][] | null
}

const NO_ACTIVITY: ProjectActivity = { open: 0, running: 0, unread: 0, waiting: 0 }
/** Offset of a new window from the focused one, like macOS cascading. */
const CASCADE = 26
const REPLY_TIMEOUT_MS = 15_000

export interface WindowsOptions {
    store: StateFile
    /** Creates a BrowserWindow (preload, handlers, page) at the given frame. */
    create: (bounds: Partial<WindowBounds>) => BrowserWindow
    stopAgent: (agentId: string) => Promise<void>
    /** Terminals with something running in these projects (the close prompt counts them). */
    busyTerminals?: (cwds: string[]) => number
    /** The projects some window shows, after every change. */
    projectsShown?: (cwds: Set<string>) => void
}

export class Windows {
    private entries = new Map<number, Entry>()
    private routes = new Map<string, Route>()
    private replies = new Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>()
    /** Transfers run one at a time. */
    private moving: Promise<unknown> = Promise.resolve()
    /** `${window id}\n${cwd}` of projects being moved out; processes started meanwhile are held too. */
    private leaving = new Set<string>()
    /** Set on quit: windows closing then stay in the saved list so they reopen next launch. */
    quitting = false

    constructor(private options: WindowsOptions) {
        ipcMain.on(IPC.reply, (_e, id: string, result: { ok: boolean, value?: unknown, error?: string }) => {
            const pending = this.replies.get(id)
            this.replies.delete(id)
            if (!pending)
                return
            if (result?.ok)
                pending.resolve(result.value)
            else
                pending.reject(new Error(result?.error || 'window request failed'))
        })
    }

    // ---------------------------------------------------------------- windows

    open(projects: string[], active?: string | null, near?: BrowserWindow | null, extra: { frame?: Partial<WindowBounds>, tabs?: Record<string, string[]>, activeTabs?: Record<string, string> } = {}): Entry {
        const saved = projects[0] ? this.options.store.state.windowBounds?.[projects[0]] : undefined
        const win = this.options.create(extra.frame ?? (saved && onScreen(saved) ? saved : cascade(near ?? BrowserWindow.getFocusedWindow())))
        let markReady = () => {}
        const ready = new Promise<void>(resolve => (markReady = resolve))
        const entry: Entry = {
            win,
            id: win.webContents.id,
            projects: [...projects],
            active: active && projects.includes(active) ? active : projects[0] ?? null,
            activity: {},
            ready,
            markReady,
            closing: false,
            tabs: { ...extra.tabs },
            activeTabs: { ...extra.activeTabs },
            focusedAt: Date.now(),
        }
        this.entries.set(entry.id, entry)
        win.on('focus', () => (entry.focusedAt = Date.now()))

        win.on('close', (event) => {
            if (!this.quitting && !entry.closing) {
                const running = Object.values(entry.activity).reduce((n, a) => n + a.running, 0)
                // Terminals end with the last window showing their project.
                const alone = entry.projects.filter(cwd => ![...this.entries.values()].some(e => e !== entry && e.projects.includes(cwd)))
                const terminals = this.options.busyTerminals?.(alone) ?? 0
                if (running > 0 || terminals > 0) {
                    const parts = [
                        running && tr(`${running} 个线程`, `${running} ${running === 1 ? 'thread' : 'threads'}`),
                        terminals && tr(`${terminals} 个终端`, `${terminals} ${terminals === 1 ? 'terminal' : 'terminals'}`),
                    ].filter(Boolean)
                    const choice = dialog.showMessageBoxSync(win, {
                        type: 'warning',
                        message: tr(`${parts.join('、')}正在运行`, `${parts.join(' and ')} ${running + terminals === 1 ? 'is' : 'are'} running`),
                        detail: tr('关闭窗口会停止它们。', 'Closing the window stops them.'),
                        buttons: [tr('关闭窗口', 'Close window'), tr('取消', 'Cancel')],
                        defaultId: 1,
                        cancelId: 1,
                    })
                    if (choice === 1) {
                        event.preventDefault()
                        return
                    }
                }
            }
            void this.saveBounds(entry)
        })
        win.on('closed', () => {
            this.entries.delete(entry.id)
            for (const [agentId, route] of this.routes) {
                if (route.owner === entry.id) {
                    this.routes.delete(agentId)
                    void this.options.stopAgent(agentId)
                }
            }
            this.changed()
        })
        this.changed()
        return entry
    }

    private saveBounds(entry: Entry): Promise<void> {
        const key = entry.projects[0]
        if (!key || entry.win.isDestroyed())
            return Promise.resolve()
        return this.options.store.update(s => ({ ...s, windowBounds: { ...s.windowBounds, [key]: entry.win.getNormalBounds() } }))
    }

    /** Quit: the window list stays as it is now, and frames are on disk before the app exits. */
    async prepareQuit() {
        this.quitting = true
        await Promise.all([...this.entries.values()].map(e => this.saveBounds(e)))
    }

    /** Closes a window the app emptied, without the running-threads prompt. */
    private dispose(entry: Entry) {
        entry.closing = true
        if (!entry.win.isDestroyed())
            entry.win.close()
    }

    /** Reopens the windows saved at the last quit, or a welcome window. */
    restore(saved: { projects: string[], active?: string, tabs?: Record<string, string[]>, activeTabs?: Record<string, string> }[]) {
        for (const w of saved)
            this.open(w.projects, w.active, null, { tabs: w.tabs, activeTabs: w.activeTabs })
        if (!this.entries.size)
            this.open([])
    }

    get count() {
        return this.entries.size
    }

    /** Window for a menu action: the focused one, else any. */
    focusedWebContents() {
        const win = BrowserWindow.getFocusedWindow()
        return (win && this.entries.get(win.webContents.id)?.win.webContents) ?? [...this.entries.values()][0]?.win.webContents
    }

    private entryOf(sender: Electron.WebContents): Entry {
        const entry = this.entries.get(sender.id)
        if (!entry)
            throw new Error('unknown window')
        return entry
    }

    /** The window showing the project; of several, the one focused last. */
    private ownerOf(cwd: string): Entry | undefined {
        let best: Entry | undefined
        for (const e of this.entries.values()) {
            if (e.projects.includes(cwd) && (!best || e.focusedAt > best.focusedAt))
                best = e
        }
        return best
    }

    /** The window showing a session as a tab. */
    private holderOf(session: string): Entry | undefined {
        return [...this.entries.values()].find(e => e.projects.some(cwd => e.tabs[cwd]?.includes(session)))
    }

    private focus(entry: Entry) {
        if (entry.win.isMinimized())
            entry.win.restore()
        reveal(entry.win, true)
    }

    /** Saves the window list, refreshes every window's view of the others and the Dock badge. */
    private changed() {
        const entries = [...this.entries.values()]
        const windows = entries.filter(e => e.projects.length).map(e => ({
            projects: e.projects,
            active: e.active ?? undefined,
            tabs: Object.fromEntries(e.projects.filter(cwd => e.tabs[cwd]).map(cwd => [cwd, e.tabs[cwd]])),
            activeTabs: Object.fromEntries(e.projects.filter(cwd => e.activeTabs[cwd]).map(cwd => [cwd, e.activeTabs[cwd]])),
        }))
        if (!this.quitting && JSON.stringify(windows) !== JSON.stringify(this.options.store.state.windows))
            void this.options.store.update(s => ({ ...s, windows }))
        const open: OpenProject[] = entries.flatMap(e => e.projects.map(cwd => ({ cwd, windowId: e.id, activity: e.activity[cwd] ?? NO_ACTIVITY })))
        const tabs: Record<string, number> = {}
        for (const e of entries) {
            for (const cwd of e.projects) {
                for (const key of e.tabs[cwd] ?? [])
                    tabs[key] ??= e.id
            }
        }
        for (const e of entries) {
            e.win.webContents.send(IPC.openProjects, open)
            e.win.webContents.send(IPC.openTabs, tabs)
        }
        const waiting = open.reduce((n, p) => n + p.activity.waiting, 0)
        app.setBadgeCount(Math.min(waiting, 999))
        if (!this.quitting)
            this.options.projectsShown?.(new Set(open.map(p => p.cwd)))
    }

    private setProjects(entry: Entry, projects: string[]) {
        for (const cwd of entry.projects) {
            if (!projects.includes(cwd)) {
                delete entry.tabs[cwd]
                delete entry.activeTabs[cwd]
            }
        }
        entry.projects = projects
        if (!entry.active || !projects.includes(entry.active))
            entry.active = projects[0] ?? null
        entry.win.webContents.send(IPC.windowProjects, projects)
    }

    /** Main → renderer request, answered on IPC.reply. */
    private ask<T>(entry: Entry, channel: string, ...args: unknown[]): Promise<T> {
        const id = randomUUID()
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.replies.delete(id)
                reject(new Error(`window did not answer ${channel}`))
            }, REPLY_TIMEOUT_MS)
            this.replies.set(id, {
                resolve: (v) => {
                    clearTimeout(timer)
                    resolve(v)
                },
                reject: (e) => {
                    clearTimeout(timer)
                    reject(e)
                },
            })
            entry.win.webContents.send(channel, id, ...args)
        })
    }

    // ---------------------------------------------------------------- renderer requests

    init(sender: Electron.WebContents): WindowInit {
        const entry = this.entryOf(sender)
        return { id: entry.id, projects: entry.projects, active: entry.active ?? undefined }
    }

    /** state.json as this window starts from it: its own tabs, and none that another window shows. */
    stateFor(sender: Electron.WebContents, state: AppState): AppState {
        const entry = this.entryOf(sender)
        const elsewhere = new Set<string>()
        for (const e of this.entries.values()) {
            if (e !== entry)
                e.projects.forEach(cwd => e.tabs[cwd]?.forEach(k => elsewhere.add(k)))
        }
        return windowState(state, { tabs: entry.tabs, activeTabs: entry.activeTabs }, elsewhere)
    }

    /**
     * Takes a window's tabs from its save. Returns the save as state.json should apply it: a project
     * shown in several windows keeps all their tabs there (the fallback for a window that has none).
     */
    recordTabs(sender: Electron.WebContents, save: StateSave): { save: StateSave, owned: string[] } {
        const entry = this.entryOf(sender)
        const tabs: Record<string, string[]> = {}
        const activeTabs: Record<string, string> = {}
        for (const cwd of entry.projects) {
            entry.tabs[cwd] = Array.isArray(save.tabs[cwd]) ? save.tabs[cwd].filter(k => typeof k === 'string') : []
            if (typeof save.activeTabs[cwd] === 'string')
                entry.activeTabs[cwd] = save.activeTabs[cwd]
            else
                delete entry.activeTabs[cwd]
            const others = [...this.entries.values()].filter(e => e !== entry && e.projects.includes(cwd))
            tabs[cwd] = unionTabs([entry.tabs[cwd], ...others.map(e => e.tabs[cwd] ?? [])])
            if (entry.activeTabs[cwd])
                activeTabs[cwd] = entry.activeTabs[cwd]
        }
        this.changed()
        return { save: { ...save, tabs, activeTabs }, owned: entry.projects }
    }

    ready(sender: Electron.WebContents) {
        this.entryOf(sender).markReady()
    }

    report(sender: Electron.WebContents, report: WindowReport) {
        const entry = this.entries.get(sender.id)
        if (!entry)
            return
        entry.active = report.active && entry.projects.includes(report.active) ? report.active : entry.active
        entry.activity = report.activity
        this.changed()
    }

    openProject(sender: Electron.WebContents, cwd: string): 'here' | 'elsewhere' {
        const entry = this.entryOf(sender)
        if (entry.projects.includes(cwd))
            return 'here'
        const owner = this.ownerOf(cwd)
        if (owner) {
            this.focus(owner)
            owner.win.webContents.send(IPC.selectProject, cwd)
            return 'elsewhere'
        }
        if (!entry.projects.length) {
            this.setProjects(entry, [cwd])
            entry.active = cwd
            this.changed()
            return 'here'
        }
        this.open([cwd], cwd, entry.win)
        return 'elsewhere'
    }

    attachProject(sender: Electron.WebContents, cwd: string) {
        const entry = this.entryOf(sender)
        if (entry.projects.includes(cwd))
            return
        const owner = this.ownerOf(cwd)
        if (owner)
            return this.transfer([cwd], owner, entry)
        this.setProjects(entry, [...entry.projects, cwd])
        this.changed()
    }

    async detachProject(sender: Electron.WebContents, cwd: string) {
        const entry = this.entryOf(sender)
        if (!entry.projects.includes(cwd) || entry.projects.length < 2)
            return
        const target = this.open([], null, entry.win)
        await target.ready
        await this.transfer([cwd], entry, target)
        target.win.webContents.send(IPC.selectProject, cwd)
    }

    closeProject(sender: Electron.WebContents, cwd: string) {
        const entry = this.entryOf(sender)
        if (!entry.projects.includes(cwd))
            return
        const rest = entry.projects.filter(p => p !== cwd)
        if (!rest.length && this.entries.size > 1) {
            void this.saveBounds(entry)
            entry.projects = []
            this.dispose(entry)
            return
        }
        this.setProjects(entry, rest)
        this.changed()
    }

    /** Every other window's projects into this one; the emptied windows close. */
    async mergeAll(sender: Electron.WebContents) {
        const target = this.entryOf(sender)
        for (const other of [...this.entries.values()]) {
            if (other !== target && other.projects.length)
                await this.transfer([...other.projects], other, target)
        }
        for (const other of [...this.entries.values()]) {
            if (other !== target && !other.projects.length)
                this.dispose(other)
        }
        this.focus(target)
    }

    /**
     * The window with the session's tab, else the one showing its project (like openProject), opens
     * the session at a message.
     */
    async revealSession(sender: Electron.WebContents, cwd: string, session: string, entryId?: string) {
        const entry = this.entryOf(sender)
        let owner = this.holderOf(session)
        if (!owner && entry.projects.includes(cwd))
            owner = entry
        if (!owner) {
            this.openProject(sender, cwd)
            owner = this.ownerOf(cwd)
        }
        if (!owner)
            return
        await owner.ready
        this.focus(owner)
        owner.win.webContents.send(IPC.revealSession, session, entryId)
    }

    focusWindow(sender: Electron.WebContents) {
        const entry = this.entries.get(sender.id)
        if (entry)
            this.focus(entry)
    }

    // ---------------------------------------------------------------- pi processes

    /** A process a window started; its events go to that window (or wait while its project moves). */
    addAgent(agentId: string, sender: Electron.WebContents, cwd: string) {
        this.routes.set(agentId, { owner: sender.id, cwd, held: this.leaving.has(`${sender.id}\n${cwd}`) ? [] : null })
    }

    deliver(agentId: string, channel: string, ...args: unknown[]) {
        const route = this.routes.get(agentId)
        if (!route)
            return
        if (route.held) {
            route.held.push([channel, args])
            return
        }
        this.entries.get(route.owner)?.win.webContents.send(channel, agentId, ...args)
        if (channel === IPC.agentExit)
            this.routes.delete(agentId)
    }

    /** Sends to every window except the sender (shared settings another window changed). */
    broadcast(sender: Electron.WebContents | null, channel: string, ...args: unknown[]) {
        for (const e of this.entries.values()) {
            if (e.win.webContents !== sender)
                e.win.webContents.send(channel, ...args)
        }
    }

    // ---------------------------------------------------------------- transfers

    /** A tab to another window (or a new one, torn off at `move.at`). */
    moveTab(sender: Electron.WebContents, move: TabMove): Promise<void> {
        const from = move.from == null ? this.entryOf(sender) : this.entries.get(move.from)
        if (!from)
            return Promise.reject(new Error('the source window is gone'))
        const run = this.moving.catch(() => {}).then(() => this.moveThread(from, move))
        this.moving = run
        return run
    }

    private async moveThread(from: Entry, move: TabMove) {
        const { cwd, key } = move
        if (!from.projects.includes(cwd) || this.entries.get(from.id) !== from)
            return
        let to = move.to == null ? undefined : this.entries.get(move.to)
        if (move.to != null && !to)
            throw new Error('the target window is gone')
        if (to === from)
            return
        to ??= this.open([], null, from.win, move.at ? { frame: frameAt(from.win, move.at) } : {})
        await to.ready
        // Every process of the project in the source is held while it hands the tab over: one may be
        // the moving thread's, starting right now.
        const leaving = `${from.id}
${cwd}`
        this.leaving.add(leaving)
        for (const route of this.routes.values()) {
            if (route.owner === from.id && route.cwd === cwd)
                route.held ??= []
        }
        let owner = from
        try {
            const transfer = await this.ask<ThreadTransfer>(from, IPC.exportThreads, [key])
            if (!transfer.remaining)
                this.setProjects(from, from.projects.filter(p => p !== cwd))
            // Listed for the target before it imports (its save during the import must count), but
            // told only after: the renderer adds the project itself, with just this tab.
            const added = !to.projects.includes(cwd)
            if (added)
                to.projects = [...to.projects, cwd]
            try {
                await this.ask(to, IPC.importThreads, { transfer, index: move.index })
                owner = to
                if (added)
                    this.setProjects(to, to.projects)
            }
            catch (error) {
                if (added)
                    this.setProjects(to, to.projects.filter(p => p !== cwd))
                if (!from.projects.includes(cwd))
                    this.setProjects(from, [...from.projects, cwd])
                await this.ask(from, IPC.importThreads, { transfer }).catch(() => {})
                throw error
            }
            finally {
                for (const agentId of transfer.agents) {
                    const route = this.routes.get(agentId)
                    if (route)
                        route.owner = owner.id
                }
            }
        }
        finally {
            this.leaving.delete(leaving)
            for (const [agentId, route] of [...this.routes]) {
                if (route.held && route.cwd === cwd && (route.owner === from.id || route.owner === to.id)) {
                    const held = route.held
                    route.held = null
                    for (const [channel, args] of held)
                        this.deliver(agentId, channel, ...args)
                }
            }
            this.changed()
            // A new window the tab never reached is not left behind empty.
            if (owner !== to && !to.projects.length && move.to == null)
                this.dispose(to)
        }
        if (!from.projects.length)
            this.dispose(from)
        this.focus(to)
    }

    private transfer(cwds: string[], from: Entry, to: Entry): Promise<void> {
        const run = this.moving.catch(() => {}).then(() => this.move(cwds, from, to))
        this.moving = run
        return run
    }

    private async move(cwds: string[], from: Entry, to: Entry) {
        cwds = cwds.filter(c => from.projects.includes(c))
        if (!cwds.length || from === to)
            return
        const keys = cwds.map(c => `${from.id}\n${c}`)
        keys.forEach(k => this.leaving.add(k))
        const moving = [...this.routes.values()].filter(r => r.owner === from.id && cwds.includes(r.cwd))
        for (const route of moving)
            route.held ??= []
        let owner = from
        try {
            await to.ready
            // The source applies every event it already got before it snapshots, then lets the threads go.
            const shown = new Set(cwds.filter(c => to.projects.includes(c)))
            const projects = (await this.ask<ProjectTransfer[]>(from, IPC.exportProjects, cwds)).map(p => ({ ...p, merge: shown.has(p.cwd) }))
            // Processes started while the source was finishing up are held as well.
            const routes = [...this.routes.values()].filter(r => r.owner === from.id && cwds.includes(r.cwd))
            this.setProjects(from, from.projects.filter(p => !cwds.includes(p)))
            this.setProjects(to, [...to.projects, ...cwds.filter(c => !to.projects.includes(c))])
            try {
                await this.ask(to, IPC.importProjects, projects)
                owner = to
            }
            catch (error) {
                // Hand everything back rather than drop live threads.
                this.setProjects(to, to.projects.filter(p => !cwds.includes(p)))
                this.setProjects(from, [...from.projects, ...cwds])
                await this.ask(from, IPC.importProjects, projects).catch(() => {})
                throw error
            }
            finally {
                for (const route of routes)
                    route.owner = owner.id
            }
        }
        finally {
            keys.forEach(k => this.leaving.delete(k))
            for (const [agentId, route] of [...this.routes]) {
                if (route.held && cwds.includes(route.cwd) && route.owner === owner.id) {
                    const held = route.held
                    route.held = null
                    for (const [channel, args] of held)
                        this.deliver(agentId, channel, ...args)
                }
            }
            this.changed()
        }
        if (!from.projects.length)
            this.dispose(from)
    }
}

/** A torn-off tab's window: the source's size, its tab strip under the pointer, kept on screen. */
function frameAt(near: BrowserWindow, at: { x: number, y: number }): Partial<WindowBounds> {
    const { width, height } = near.getNormalBounds()
    const area = screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.y) }).workArea
    const x = Math.min(Math.max(area.x, Math.round(at.x) - 120), area.x + area.width - width)
    const y = Math.min(Math.max(area.y, Math.round(at.y) - 20), area.y + area.height - height)
    return { x: Math.max(area.x, x), y: Math.max(area.y, y), width: Math.min(width, area.width), height: Math.min(height, area.height) }
}

function cascade(near: BrowserWindow | null): Partial<WindowBounds> {
    if (!near)
        return {}
    const b = near.getNormalBounds()
    const area = screen.getDisplayMatching(b).workArea
    const x = b.x + CASCADE + b.width > area.x + area.width ? area.x : b.x + CASCADE
    const y = b.y + CASCADE + b.height > area.y + area.height ? area.y : b.y + CASCADE
    return { x, y, width: b.width, height: b.height }
}

/** A saved frame is reused only while most of it is on some display. */
function onScreen(b: WindowBounds): boolean {
    const area = screen.getDisplayMatching(b).workArea
    const w = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x)
    const h = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y)
    return w > 0 && h > 0 && w * h >= b.width * b.height * 0.5
}
