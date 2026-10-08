import type { AgentStartOptions, GlobalCompactionPatch, SearchResult, StateSave, TabMove, ThemePref, WindowBounds, WindowReport } from '@shared/ipc'
import type { LoginUpdate } from '@shared/providers'
import { acpAgent, agentOfKey, parseAcpSessionKey } from '@shared/agents'
import { APP_INFO } from '@shared/app'
import { resolveLang } from '@shared/i18n'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { SessionFollower } from './follow'
import { PresenceWatcher, presenceDir } from './presence'
import { DEFAULT_THEME, IPC, THEME_PREFS } from '@shared/ipc'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, Notification, shell } from 'electron'
import { AcpService } from './acp/service'
import { AgentManager } from './agents'
import { BACKGROUND, reveal } from './background'
import { applySave, savedWindows, StateFile } from './appState'
import { repoEdits } from './edits'
import { gitBranch, gitCommit, gitDiscard, gitFileBytes, gitFileDiff, gitFileEntries, gitFileThumbs, gitStatus } from './git'
import { mainLang, setMainLang, tr } from './i18n'
import { compactionInfo, globalCompaction, setGlobalCompaction } from './piSettings'
import { endpointSaveOf, helperLaunch, ProviderHelper, ProviderService } from './providers'
import { resolvePiEnv, setBundledPi } from './pi-env'
import { assertInSessionsDir, listSessions, readSession } from './sessions'
import { platform } from './platform'
import { windowPlatform } from './platform/window'
import { TerminalTools } from './terminalTools'
import { Terminals } from './terminals'
import { Windows } from './windows'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// productName "Filo" would move userData to ~/Library/Application Support/Filo; keep the existing
// pi-gui folder so saved projects and tabs survive the renames (pi-gui → Pi → Filo). PI_GUI_USER_DATA isolates test runs.
app.setPath('userData', process.env.PI_GUI_USER_DATA || path.join(app.getPath('appData'), 'pi-gui'))
app.setName(APP_INFO.name)
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const store = new StateFile(() => path.join(app.getPath('userData'), 'state.json'))

// pi loads capability extensions from real files, so packaged builds keep the pi-capabilities package
// (extensions plus the helpers they import) outside the asar, as Resources/capabilities.
const extensionsDir = app.isPackaged ? path.join(process.resourcesPath, 'capabilities', 'extensions') : path.join(__dirname, '../../packages/capabilities/extensions')

// The pi shipped for users without one (electron/pi-env.ts): Resources/pi, installed by
// scripts/bundle-pi.sh; in development the pi devDependency.
const PI_CLI = path.join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
setBundledPi(app.isPackaged
    ? { cli: path.join(process.resourcesPath, 'pi', PI_CLI), launcher: path.join(process.resourcesPath, 'piLauncher.mjs') }
    : { cli: path.join(__dirname, '../..', PI_CLI), launcher: path.join(__dirname, '../../electron/piLauncher.mjs') })

const agents = new AgentManager({
    onEvent: (agentId, event) => windows.deliver(agentId, IPC.agentEvent, event),
    onExit: (agentId, info) => windows.deliver(agentId, IPC.agentExit, info),
}, extensionsDir, () => terminalTools.env())

// Sessions of ACP agents (Codex, …) started from the app; the agents keep the conversations.
const acpMirrorDir = () => path.join(app.getPath('userData'), 'acp-transcripts')
const acp = new AcpService(
    () => path.join(app.getPath('userData'), 'acp-sessions.json'),
    acpMirrorDir,
    // Agents the app installs (Settings → Agents, or picking one that is not installed).
    () => path.join(app.getPath('userData'), 'agents'),
    () => windows.broadcast(null, IPC.agentsChanged),
    url => net.fetch(url),
)

const windows = new Windows({
    store,
    create: createWindow,
    stopAgent: id => agents.stop(id),
    busyTerminals: cwds => terminals.busyIn(cwds),
    projectsShown: (cwds) => {
        shownProjects = cwds
        closeHiddenTerminals(cwds)
    },
})

// The Terminal tool window. node-pty is native, so it is not bundled: packaged builds carry it as
// Resources/node-pty (package.json build.extraResources).
const terminals = new Terminals({
    ptyDir: app.isPackaged ? path.join(process.resourcesPath, 'node-pty') : path.join(__dirname, '../../node_modules/node-pty'),
    onChange: list => windows.broadcast(null, IPC.terminalsChanged, list),
    appVersion: app.getVersion(),
})

/**
 * The agent's terminal tools (the terminal capability) reach the terminals through this socket. Named
 * per app process, so a second instance (a test run, a dev build) has its own.
 */
const terminalTools = new TerminalTools(terminals, platform.ipcPath(app.getPath('userData'), `terminals-${process.pid}.sock`), () => shownProjects)

/**
 * A project no window shows any more takes its terminals with it. Checked a moment later, so a
 * project passing between windows (or a window reloading) keeps them.
 */
let hiddenTimer: ReturnType<typeof setTimeout> | undefined
let shownProjects = new Set<string>()
function closeHiddenTerminals(shown: Set<string>) {
    clearTimeout(hiddenTimer)
    hiddenTimer = setTimeout(() => void terminals.closeOutside(shown), 2000)
}

/**
 * Settings → 模型供应商. The helper runs with the user's node and pi, so it is a real file outside the
 * asar (Resources/providerHelper.mts). A login's updates go to the window that started it.
 */
const providers = (() => {
    const script = app.isPackaged ? path.join(process.resourcesPath, 'providerHelper.mts') : path.join(__dirname, '../../electron/providerHelper.mts')
    const owners = new Map<string, Electron.WebContents>()
    const deliver = (update: LoginUpdate) => {
        const owner = owners.get(update.login)
        if (owner && !owner.isDestroyed())
            owner.send(IPC.providerLoginUpdate, update)
        if ('done' in update || 'error' in update)
            owners.delete(update.login)
        if ('done' in update)
            windows.broadcast(null, IPC.providersChanged)
    }
    const helper = new ProviderHelper(async () => {
        const env = await resolvePiEnv()
        if (!env.ok)
            throw new Error(env.error)
        return helperLaunch(env.env, script)
    }, deliver)
    const service = new ProviderService(helper, () => windows.broadcast(null, IPC.providersChanged), (input, init) => net.fetch(String(input), init))
    return {
        service,
        login(owner: Electron.WebContents, provider: string, method: 'api_key' | 'oauth') {
            const login = helper.login(provider, method)
            owners.set(login, owner)
            // A window closed mid-login leaves nobody to answer its prompts.
            owner.once('destroyed', () => owners.has(login) && helper.cancel(login))
            return login
        },
    }
})()

/** Terminal pi sessions; every window gets the list when it changes. */
const follower = new SessionFollower(IPC.sessionChanged)
const presence = new PresenceWatcher(presenceDir(), list => windows.broadcast(null, IPC.presence, list))

/** Session search runs in a worker thread (searchWorker.ts), started on first use. */
const search = (() => {
    let worker: Worker | null = null
    let next = 0
    const pending = new Map<number, { resolve: (r: SearchResult[]) => void, reject: (e: Error) => void }>()
    const start = () => {
        const w = new Worker(path.join(__dirname, 'searchWorker.js'), { workerData: { cacheFile: path.join(app.getPath('userData'), 'search-index.json'), mirrorDir: acpMirrorDir() } })
        w.on('message', ({ id, ok, results, error }) => {
            const p = pending.get(id)
            pending.delete(id)
            if (ok)
                p?.resolve(results)
            else
                p?.reject(new Error(error))
        })
        w.on('error', (error) => {
            for (const p of pending.values())
                p.reject(error)
            pending.clear()
            worker = null
        })
        return w
    }
    return {
        search(query: string): Promise<SearchResult[]> {
            worker ??= start()
            const id = ++next
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject })
                worker!.postMessage({ id, query })
            })
        },
    }
})()

/** Shown notifications, kept referenced so their click handlers survive garbage collection. */
const notices = new Set<Notification>()

function showNotice(notice: unknown) {
    const n = notice as Record<string, unknown> | null
    // A background (scripted) app never looks focused, so it would notify about every finished run.
    if (BACKGROUND || !n || typeof n.title !== 'string' || typeof n.body !== 'string' || typeof n.key !== 'string' || !Notification.isSupported())
        return
    const key = n.key.slice(0, 1000)
    const shown = new Notification({ title: n.title.slice(0, 200), body: n.body.slice(0, 500) })
    notices.add(shown)
    const drop = () => notices.delete(shown)
    // Whichever window holds the thread now (it may have moved) focuses itself.
    shown.on('click', () => {
        drop()
        windows.broadcast(null, IPC.notificationClick, key)
    })
    shown.on('close', drop)
    shown.show()
    if (n.urgent === true)
        windowPlatform.attention()
}

function isSafeExternalUrl(url: string) {
    try {
        return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)
    }
    catch {
        return false
    }
}

/** Matches the renderer's surface colour so there is no white flash before first paint. */
// Window frame colour behind the islands (--ide-frame), so resizing never flashes another colour.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#26282c' : '#e9eaee')
/** The frame's colours: the toolbar's background, and caption buttons (Windows, Linux) readable on it. */
const frameColors = () => ({ background: windowBackground(), symbols: nativeTheme.shouldUseDarkColors ? '#dfe1e5' : '#1d1d1f' })

function applyTheme(theme: unknown) {
    nativeTheme.themeSource = THEME_PREFS.includes(theme as ThemePref) ? (theme as ThemePref) : DEFAULT_THEME
}

/** Menus and the About panel are built from the current language, so both are redone on a change. */
function applyLang(pref: unknown) {
    setMainLang(resolveLang(pref, app.getPreferredSystemLanguages()))
    app.setAboutPanelOptions({
        applicationName: APP_INFO.name,
        applicationVersion: app.getVersion(),
        // Second line of the macOS About panel.
        version: APP_INFO.tagline[mainLang()],
        credits: APP_INFO.description[mainLang()],
        copyright: `© ${new Date().getFullYear()} ${APP_INFO.author}`,
        website: APP_INFO.homepage,
        iconPath: path.join(__dirname, '../../build/icon.png'),
    })
    buildMenu()
}

function createWindow(bounds: Partial<WindowBounds>): BrowserWindow {
    const win = new BrowserWindow({
        width: 1360,
        height: 880,
        ...bounds,
        minWidth: 880,
        minHeight: 560,
        title: APP_INFO.name,
        ...windowPlatform.frame(frameColors()),
        backgroundColor: windowBackground(),
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: !BACKGROUND,
        },
    })
    win.once('ready-to-show', () => reveal(win, false))

    // Links in agent output open in the system browser; the app window never navigates away.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url))
            void shell.openExternal(url)
        return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
        if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL))
            return
        event.preventDefault()
        if (isSafeExternalUrl(url))
            void shell.openExternal(url)
    })

    if (DEV_SERVER_URL)
        void win.loadURL(DEV_SERVER_URL)
    else
        // PI_GUI_TEST exposes the store to end-to-end scripts (test/windows.ts), as dev builds do.
        void win.loadFile(path.join(__dirname, '../../dist/index.html'), process.env.PI_GUI_TEST ? { query: { test: '1' } } : undefined)
    return win
}

const cwdList = (value: unknown): string[] => Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string' && path.isAbsolute(c)) : []
const absolutePath = (value: unknown): string => {
    if (typeof value !== 'string' || !path.isAbsolute(value))
        throw new Error('expected an absolute path')
    return value
}

function registerIpc() {
    ipcMain.handle(IPC.resolveEnv, () => resolvePiEnv())
    ipcMain.handle(IPC.listAgents, () => acp.availability())
    ipcMain.handle(IPC.installAgent, (_e, id: unknown) => {
        const spec = typeof id === 'string' ? acpAgent(id) : undefined
        if (!spec)
            throw new Error('unknown agent')
        return acp.install(spec.id)
    })
    ipcMain.handle(IPC.listSessions, async () => {
        const pi = await listSessions()
        const known = new Set([...store.state.projects, ...pi.map(s => s.cwd)])
        const others = await acp.listSessions(known)
        return [...pi, ...others].sort((a, b) => b.updatedAt - a.updatedAt)
    })
    ipcMain.handle(IPC.readSession, (_e, file: string) => (parseAcpSessionKey(file) ? acp.readSession(file) : readSession(file)))
    ipcMain.handle(IPC.presence, () => presence.current)
    ipcMain.handle(IPC.followSession, async (e, file: unknown, on: unknown) => {
        if (typeof file !== 'string')
            return
        await assertInSessionsDir(file)
        follower.follow(e.sender, file, on === true)
    })
    // ACP sessions are indexed through their pi-format copies; results name the session key.
    ipcMain.handle(IPC.searchSessions, async (_e, query: unknown) => (await search.search(typeof query === 'string' ? query.slice(0, 500) : ''))
        .map(r => ({ ...r, session: acp.keyOfMirror(r.session) ?? r.session })))
    ipcMain.handle(IPC.trashSession, async (_e, file: string, options?: { history?: unknown }) => {
        if (parseAcpSessionKey(file)) {
            if (options?.history === true)
                await acp.deleteHistory(file)
            else
                acp.remove(file)
            return
        }
        await assertInSessionsDir(file)
        await shell.trashItem(file)
    })

    ipcMain.handle(IPC.loadState, e => windows.stateFor(e.sender, store.state))
    ipcMain.handle(IPC.saveState, (e, save: StateSave) => {
        if (!save || typeof save !== 'object' || !save.prefs || !save.tabs || !save.activeTabs)
            return
        let changed = {}
        const { save: merged, owned } = windows.recordTabs(e.sender, save)
        const written = store.update((state) => {
            const result = applySave(state, merged, owned)
            changed = result.changed
            return result.state
        })
        if (Object.keys(changed).length)
            windows.broadcast(e.sender, IPC.prefsChanged, changed)
        return written
    })
    ipcMain.handle(IPC.pickFolder, async (e) => {
        const parent = BrowserWindow.fromWebContents(e.sender)
        const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : result.filePaths[0] ?? null
    })

    ipcMain.handle(IPC.windowInit, e => windows.init(e.sender))
    ipcMain.handle(IPC.windowReady, e => windows.ready(e.sender))
    ipcMain.handle(IPC.reportWindow, (e, report: WindowReport) => {
        if (report && typeof report === 'object' && report.activity && typeof report.activity === 'object')
            windows.report(e.sender, report)
    })
    ipcMain.handle(IPC.openProject, (e, cwd: unknown) => windows.openProject(e.sender, absolutePath(cwd)))
    ipcMain.handle(IPC.attachProject, (e, cwd: unknown) => windows.attachProject(e.sender, absolutePath(cwd)))
    ipcMain.handle(IPC.detachProject, (e, cwd: unknown) => windows.detachProject(e.sender, absolutePath(cwd)))
    ipcMain.handle(IPC.closeProject, (e, cwd: unknown) => windows.closeProject(e.sender, absolutePath(cwd)))
    ipcMain.handle(IPC.mergeAllWindows, e => windows.mergeAll(e.sender))
    ipcMain.handle(IPC.focusWindow, e => windows.focusWindow(e.sender))
    ipcMain.handle(IPC.moveTab, (e, move: TabMove) => {
        if (!move || typeof move.key !== 'string' || typeof move.cwd !== 'string' || (move.to !== null && !Number.isInteger(move.to)))
            throw new Error('bad tab move')
        const at = move.at && Number.isFinite(move.at.x) && Number.isFinite(move.at.y) ? { x: move.at.x, y: move.at.y } : undefined
        const index = Number.isInteger(move.index) ? move.index : undefined
        // A window may pull a tab only into itself (its drop zone); otherwise it moves its own.
        if (move.from != null && move.to !== e.sender.id)
            throw new Error('bad tab move')
        return windows.moveTab(e.sender, { key: move.key, cwd: move.cwd, from: Number.isInteger(move.from) ? move.from : undefined, to: move.to, index, at })
    })
    ipcMain.handle(IPC.revealSession, async (e, cwd: unknown, session: unknown, entryId: unknown) => {
        if (typeof session !== 'string')
            throw new Error('expected a session path')
        await assertInSessionsDir(session)
        await windows.revealSession(e.sender, absolutePath(cwd), session, typeof entryId === 'string' ? entryId : undefined)
    })

    const isDirectory = (dir: string) => stat(dir).then(s => s.isDirectory(), () => false)
    ipcMain.handle(IPC.agentStart, async (e, options: AgentStartOptions) => {
        const kind = options.sessionPath ? agentOfKey(options.sessionPath) : options.agent ?? 'pi'
        if (kind !== 'pi') {
            if (!(await isDirectory(options.cwd)))
                throw new Error(tr(`项目目录不存在：${options.cwd}`, `Project folder not found: ${options.cwd}`))
            const agentId = await agents.startAcp(acp, kind, options)
            windows.addAgent(agentId, e.sender, options.cwd)
            return agentId
        }
        const env = await resolvePiEnv()
        if (!env.ok)
            throw new Error(env.error)
        if (options.sessionPath)
            await assertInSessionsDir(options.sessionPath)
        // A terminal pi holds this session with pi-cc-tui's bridge: join it rather than start a second
        // process on the same file (that forks the conversation).
        const terminal = options.sessionPath ? presence.current.find(p => p.session === options.sessionPath && p.bridge) : undefined
        if (terminal?.bridge) {
            try {
                const agentId = await agents.attach(terminal.bridge, terminal.pid, terminal.bridgeToken)
                windows.addAgent(agentId, e.sender, options.cwd)
                return agentId
            }
            catch {}
        }
        // spawn reports a missing cwd as "spawn <node> ENOENT", which reads like node is missing.
        if (!(await isDirectory(options.cwd)))
            throw new Error(tr(`项目目录不存在：${options.cwd}`, `Project folder not found: ${options.cwd}`))
        const agentId = agents.start(env.env, options)
        windows.addAgent(agentId, e.sender, options.cwd)
        return agentId
    })
    ipcMain.handle(IPC.agentRequest, (_e, agentId: string, command: Record<string, unknown>) => agents.request(agentId, command))
    ipcMain.handle(IPC.agentSend, (_e, agentId: string, record: Record<string, unknown>) => agents.send(agentId, record))
    ipcMain.handle(IPC.agentStop, (_e, agentId: string) => agents.stop(agentId))

    ipcMain.handle(IPC.compactionInfo, (_e, cwd: unknown, modelKey: unknown) =>
        compactionInfo(typeof cwd === 'string' ? cwd : '', typeof modelKey === 'string' ? modelKey : undefined))
    ipcMain.handle(IPC.globalCompaction, (_e, cwd: unknown) => globalCompaction(typeof cwd === 'string' ? cwd : undefined))
    ipcMain.handle(IPC.setGlobalCompaction, async (e, patch: unknown) => {
        await setGlobalCompaction(patch)
        // pi reads settings.json at startup: the other windows restart their idle processes too.
        windows.broadcast(e.sender, IPC.piSettingsChanged, patch as GlobalCompactionPatch)
    })
    ipcMain.handle(IPC.gitStatus, (_e, cwd: string) => gitStatus(cwd))
    ipcMain.handle(IPC.gitBranches, async (_e, cwds: unknown) => {
        const list = cwdList(cwds).slice(0, 200)
        return Object.fromEntries(await Promise.all(list.map(async cwd => [cwd, await gitBranch(cwd)] as const)))
    })
    ipcMain.handle(IPC.gitFileDiff, (_e, cwd: string, file: string, status: string) => gitFileDiff(cwd, file, status))
    // Previews: both sides of a changed file, as bytes, QuickLook thumbnails or archive entries.
    for (const [channel, read] of [[IPC.gitFileBytes, gitFileBytes], [IPC.gitFileThumbs, gitFileThumbs], [IPC.gitFileEntries, gitFileEntries]] as const) {
        ipcMain.handle(channel, (_e, cwd: unknown, file: unknown, status: unknown, origPath: unknown) =>
            read(absolutePath(cwd), String(file ?? ''), String(status ?? ''), typeof origPath === 'string' && origPath ? origPath : undefined))
    }
    ipcMain.handle(IPC.repoEdits, async (_e, cwd: unknown) => repoEdits(absolutePath(cwd), await acp.mirrors(), file => acp.keyOfMirror(file)))
    ipcMain.handle(IPC.gitDiscard, (_e, cwd: unknown, files: unknown) => {
        if (!Array.isArray(files))
            throw new Error('expected a file list')
        return gitDiscard(absolutePath(cwd), files.slice(0, 5000), file => shell.trashItem(file))
    })
    ipcMain.handle(IPC.gitCommit, (_e, cwd: unknown, message: unknown, paths: unknown) =>
        gitCommit(absolutePath(cwd), typeof message === 'string' ? message : '', Array.isArray(paths) ? paths : []))

    ipcMain.handle(IPC.setTheme, (_e, theme: unknown) => applyTheme(theme))
    ipcMain.handle(IPC.setLang, (_e, lang: unknown) => applyLang(lang))
    ipcMain.handle(IPC.missingFolders, async (_e, paths: unknown) => {
        const list = cwdList(paths).slice(0, 500)
        const exists = await Promise.all(list.map(isDirectory))
        return list.filter((_, i) => !exists[i])
    })
    ipcMain.handle(IPC.openFolder, async (_e, folder: string) => {
        const error = await shell.openPath(folder)
        if (error)
            throw new Error(error)
    })
    ipcMain.handle(IPC.notify, (_e, notice: unknown) => showNotice(notice))
    ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
        if (isSafeExternalUrl(url))
            await shell.openExternal(url)
    })

    const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : '')
    ipcMain.handle(IPC.providers, () => providers.service.state())
    ipcMain.handle(IPC.providerLogin, (e, provider: unknown, method: unknown) => providers.login(e.sender, id(provider), method === 'oauth' ? 'oauth' : 'api_key'))
    ipcMain.handle(IPC.providerAnswer, (_e, login: unknown, promptId: unknown, value: unknown) => {
        providers.service.helper.answer(id(login), id(promptId), typeof value === 'string' ? value.slice(0, 8192) : '')
    })
    ipcMain.handle(IPC.providerCancel, (_e, login: unknown) => providers.service.helper.cancel(id(login)))
    ipcMain.handle(IPC.providerLogout, (_e, provider: unknown) => providers.service.logout(id(provider)))
    ipcMain.handle(IPC.saveEndpoint, (_e, save: unknown) => providers.service.saveEndpoint(endpointSaveOf(save)))
    ipcMain.handle(IPC.removeEndpoint, (_e, endpoint: unknown) => providers.service.removeEndpoint(id(endpoint)))
    ipcMain.handle(IPC.endpointModels, (_e, baseUrl: unknown, api: unknown, apiKey: unknown, provider: unknown) =>
        providers.service.endpointModels(typeof baseUrl === 'string' ? baseUrl : '', typeof api === 'string' ? api : '', typeof apiKey === 'string' ? apiKey : undefined, id(provider) || undefined))

    const terminalId = (v: unknown) => (typeof v === 'string' && v.length <= 100 ? v : '')
    ipcMain.handle(IPC.terminals, () => terminals.list())
    ipcMain.handle(IPC.terminalCreate, (_e, create: unknown) => {
        const c = (create ?? {}) as Record<string, unknown>
        return terminals.create({
            cwd: absolutePath(c.cwd),
            cols: typeof c.cols === 'number' ? c.cols : undefined,
            rows: typeof c.rows === 'number' ? c.rows : undefined,
            command: typeof c.command === 'string' ? c.command.slice(0, 10_000) : undefined,
            label: typeof c.label === 'string' ? c.label.slice(0, 100) : undefined,
        })
    })
    ipcMain.handle(IPC.terminalAttach, (e, tid: unknown) => {
        const sender = e.sender
        if (!attachedSenders.has(sender.id)) {
            attachedSenders.add(sender.id)
            sender.once('destroyed', () => {
                attachedSenders.delete(sender.id)
                terminals.detachAll(sender.id)
            })
        }
        return terminals.attach(terminalId(tid), sender)
    })
    ipcMain.on(IPC.terminalDetach, (e, tid: unknown) => terminals.detach(terminalId(tid), e.sender.id))
    // Keystrokes and resizes are fire-and-forget: no reply per key.
    ipcMain.on(IPC.terminalWrite, (_e, tid: unknown, data: unknown) => {
        if (typeof data === 'string')
            terminals.write(terminalId(tid), data.slice(0, 1024 * 1024))
    })
    ipcMain.on(IPC.terminalResize, (_e, tid: unknown, cols: unknown, rows: unknown) => {
        if (typeof cols === 'number' && typeof rows === 'number')
            terminals.resize(terminalId(tid), cols, rows)
    })
    ipcMain.handle(IPC.terminalClose, (_e, tid: unknown) => terminals.close(terminalId(tid)))
    ipcMain.handle(IPC.terminalRestart, (_e, tid: unknown) => terminals.restart(terminalId(tid)))
    ipcMain.handle(IPC.terminalText, (_e, tid: unknown, lines: unknown) => terminals.text(terminalId(tid), typeof lines === 'number' ? lines : undefined))
}

/** Windows that attached a terminal; each gets one cleanup when it goes away (or reloads its page). */
const attachedSenders = new Set<number>()

/**
 * App menu without a ⌘W "Close Window" item: ⌘W, ⌘T, ⌘1–9 and ⌘\ are tab shortcuts handled by the
 * renderer. Each OS lays it out its own way (platform/darwin.ts, platform/desktop.ts).
 */
function buildMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate(windowPlatform.menu({
        settings: {
            label: tr('设置…', 'Settings…'),
            accelerator: 'CmdOrCtrl+,',
            click: () => windows.focusedWebContents()?.send(IPC.openSettings),
        },
        mergeWindows: {
            // WebStorm's "Merge All Project Windows": the other windows' projects join this one.
            label: tr('合并所有窗口', 'Merge All Windows'),
            click: () => {
                const target = windows.focusedWebContents()
                if (target)
                    void windows.mergeAll(target).catch(error => dialog.showErrorBox(tr('合并窗口失败', 'Could not merge windows'), String(error?.message ?? error)))
            },
        },
    })))
}

app.whenReady().then(async () => {
    // Apply the saved appearance before the window exists so the first frame already matches.
    const state = await store.load()
    applyTheme(state.theme)
    nativeTheme.on('updated', () => {
        for (const w of BrowserWindow.getAllWindows()) {
            w.setBackgroundColor(windowBackground())
            windowPlatform.restyle(w, frameColors())
        }
    })
    if (!app.isPackaged && !BACKGROUND)
        windowPlatform.devIcon(path.join(__dirname, '../../build/icon.png'))
    applyLang(state.lang)
    registerIpc()
    // Before the first window, so the first threads' pi already gets the socket.
    await terminalTools.start().catch(error => console.error('terminal tools:', error))
    windows.restore(savedWindows(state))
    // Warm up env resolution so the first thread starts faster.
    void resolvePiEnv()
    void presence.start()
    app.on('activate', () => {
        if (!windows.count)
            windows.restore([])
    })
})

let quitting = false
app.on('before-quit', (event) => {
    if (quitting)
        return
    quitting = true
    event.preventDefault()
    presence.stop()
    terminalTools.stop()
    providers.service.helper.stop()
    void Promise.all([windows.prepareQuit(), agents.stopAll(), terminals.closeAll()]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
    if (windowPlatform.quitWithLastWindow)
        app.quit()
})
