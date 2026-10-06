// One project per window, as in WebStorm. A window can also hold several projects after the user
// merges windows (or attaches a project); its project tree then lists them all. Projects move between
// windows live: the source window hands over its threads' state and main re-routes their pi
// processes, holding back events until the target window has taken them.
import type { OpenProject, ProjectActivity, ProjectTransfer, WindowBounds, WindowInit, WindowReport } from '@shared/ipc'
import type { StateFile } from './appState'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
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

    open(projects: string[], active?: string | null, near?: BrowserWindow | null): Entry {
        const saved = projects[0] ? this.options.store.state.windowBounds?.[projects[0]] : undefined
        const win = this.options.create(saved && onScreen(saved) ? saved : cascade(near ?? BrowserWindow.getFocusedWindow()))
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
        }
        this.entries.set(entry.id, entry)

        win.on('close', (event) => {
            if (!this.quitting && !entry.closing) {
                const running = Object.values(entry.activity).reduce((n, a) => n + a.running, 0)
                if (running > 0) {
                    const choice = dialog.showMessageBoxSync(win, {
                        type: 'warning',
                        message: tr(`${running} 个线程正在运行`, `${running} ${running === 1 ? 'thread is' : 'threads are'} running`),
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
    restore(saved: { projects: string[], active?: string }[]) {
        for (const w of saved)
            this.open(w.projects, w.active)
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

    private ownerOf(cwd: string): Entry | undefined {
        return [...this.entries.values()].find(e => e.projects.includes(cwd))
    }

    private focus(entry: Entry) {
        if (entry.win.isMinimized())
            entry.win.restore()
        entry.win.show()
        entry.win.focus()
    }

    /** Saves the window list, refreshes every window's view of the others and the Dock badge. */
    private changed() {
        const entries = [...this.entries.values()]
        const windows = entries.filter(e => e.projects.length).map(e => ({ projects: e.projects, active: e.active ?? undefined }))
        if (!this.quitting && JSON.stringify(windows) !== JSON.stringify(this.options.store.state.windows))
            void this.options.store.update(s => ({ ...s, windows }))
        const open: OpenProject[] = entries.flatMap(e => e.projects.map(cwd => ({ cwd, windowId: e.id, activity: e.activity[cwd] ?? NO_ACTIVITY })))
        for (const e of entries)
            e.win.webContents.send(IPC.openProjects, open)
        const waiting = open.reduce((n, p) => n + p.activity.waiting, 0)
        app.setBadgeCount(Math.min(waiting, 999))
    }

    private setProjects(entry: Entry, projects: string[]) {
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
        const owner = this.ownerOf(cwd)
        if (owner === entry)
            return 'here'
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
        const owner = this.ownerOf(cwd)
        if (owner === entry)
            return
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
            const projects = await this.ask<ProjectTransfer[]>(from, IPC.exportProjects, cwds)
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
