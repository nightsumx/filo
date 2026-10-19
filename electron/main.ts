import type { AgentStartOptions, CacheWarming, ClaudeMcpAdd, ClaudeMcpRemove, CodexMcpAdd, GrokMcpAdd, PiMcpAdd, SearchResult, StateSave, TabMove, ThemePref, WindowBounds, WindowReport } from '@shared/ipc'
import type { LoginUpdate } from '@shared/providers'
import { acpAgent, agentOfKey, parseAcpSessionKey } from '@shared/agents'
import { SETUP_TOOL_IDS, SETUP_VERSION } from '@shared/setup'
import { APP_INFO } from '@shared/app'
import { resolveLang } from '@shared/i18n'
import { AGENT_APIS, TERMINAL_AGENTS } from '@shared/routes'
import { appendFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { SessionFollower } from './follow'
import { PresenceWatcher, presenceDir } from './presence'
import { DEFAULT_THEME, IPC, THEME_PREFS } from '@shared/ipc'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, Notification, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { changeCodexPlugins, codexApps, codexFeatures, codexMemory, codexPlugins, codexMcpServers, resetCodexMemory, setCodexApp, setCodexFeature, writeCodexMcp } from './native/codex'
import { AcpService } from './acp/service'
import { claudeMcpServers, codexMcpTable, codexPluginChange, codexServerName, claudeMemory, setClaudeAutoMemory, mcpAddArgs, mcpRemoveArgs } from './claudeSettings'
import { AgentManager } from './agents'
import { BACKGROUND, reveal } from './background'
import { applySave, savedWindows, StateFile } from './appState'
import { repoEdits } from './edits'
import { FolderWatch, listDir, projectSources, readText, realPathOf, writeText } from './files'
import { applyWorktree, createWorktree, gitBranch, gitCommit, gitDiscard, gitFileBytes, gitFileDiff, gitFileEntries, gitFileThumbs, gitStatus, removeWorktree, threadTask, worktreeParent } from './git'
import { mainLang, setMainLang, tr } from './i18n'
import { GROK_MCP_LIST, grokMcpAddArgs, grokMcpEnableArgs, grokMcpRemoveArgs, parseGrokMcp } from './grokSettings'
import { piMcpAddArgs, piMcpRemoveArgs, piMcpServers, setPiMcp } from './piMcp'
import { installPackage, runPi, WEB_ACCESS } from './piPackages'
import { listSkills, shareSkills } from './skills'
import { agentDir, compactionInfo, enabledModels, globalCompaction, piDefaults, piSettingsState, setCacheWarming, setCapabilities, setDefaultModel, setDefaultThinkingLevel, setEnabledModels, setGlobalCompaction, setWebAccess, watchSettings } from './piSettings'
import { ChannelTests } from './channelTests'
import { priceList, readPricesFrom, refreshPrices } from './prices'
import { endpointSaveOf, helperLaunch, ProviderHelper, ProviderService } from './providers'
import { resolvePiEnv } from './pi-env'
import { installCommand, liveSetupDeps, probeSetup, SETUP_LABELS } from './setup'
import { assertInSessionsDir, importSession, listSessions, readSession, sessionsDir } from './sessions'
import { readLedger } from 'pi-capabilities/lib/ledger.ts'
import { platform } from './platform'
import { RoutesService } from './routes'
import { windowPlatform } from './platform/window'
import { parseAddress } from './browserText'
import { BrowserTools } from './browserTools'
import { Browsers } from './browsers'
import { TerminalTools } from './terminalTools'
import { Terminals } from './terminals'
import { useTerminals } from './native/claudeTui'
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

const agents = new AgentManager({
    onEvent: (agentId, event) => {
        if (event.type === 'agent_start' || event.type === 'agent_end')
            routes.running(agentId, event.type === 'agent_start')
        windows.deliver(agentId, IPC.agentEvent, event)
    },
    onExit: (agentId, info) => windows.deliver(agentId, IPC.agentExit, info),
}, extensionsDir, () => ({ ...terminalTools.env(), ...browserTools.env() }))

// Sessions of ACP agents (Codex, …) started from the app; the agents keep the conversations.
const acpMirrorDir = () => path.join(app.getPath('userData'), 'acp-transcripts')
const execFileAsync = promisify(execFile)
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
        browsers.reconcile(cwds)
    },
})

// The Terminal tool window. node-pty is native, so it is not bundled: packaged builds carry it as
// Resources/node-pty (package.json build.extraResources).
const terminals = new Terminals({
    ptyDir: app.isPackaged ? path.join(process.resourcesPath, 'node-pty') : path.join(__dirname, '../../node_modules/node-pty'),
    onChange: list => windows.broadcast(null, IPC.terminalsChanged, list),
    appVersion: app.getVersion(),
})
// Claude Code threads run its TUI in one of these.
useTerminals(terminals, path.join(app.getPath('userData'), 'claude-tui.json'))

/**
 * The agent's terminal tools (the terminal capability) reach the terminals through this socket. Named
 * per app process, so a second instance (a test run, a dev build) has its own.
 */
const terminalTools = new TerminalTools(terminals, platform.ipcPath(app.getPath('userData'), `terminals-${process.pid}.sock`), () => shownProjects)

// The Browser tool window: pages in views over the window, driven by the browser capability.
const browsers: Browsers = new Browsers({
    windowOf: cwd => windows.windowFor(cwd),
    onChange: list => windows.broadcast(null, IPC.browsersChanged, list),
    onKey: (window, event) => window.webContents.send(IPC.browserKey, event),
})
const browserTools = new BrowserTools(browsers, platform.ipcPath(app.getPath('userData'), `browser-${process.pid}.sock`), () => shownProjects)

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
 * Settings → 供应商. The helper runs with the user's node and pi, so it is a real file outside the
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
        if ('done' in update) {
            void routes.providersChanged()
            void refreshPrices()
            windows.broadcast(null, IPC.providersChanged)
        }
    }
    const helper = new ProviderHelper(async () => {
        const env = await resolvePiEnv()
        if (!env.ok)
            throw new Error(env.error)
        return helperLaunch(env.env, script)
    }, deliver)
    const service = new ProviderService(helper, () => {
        void routes.providersChanged()
        void refreshPrices()
        windows.broadcast(null, IPC.providersChanged)
    }, (input, init) => net.fetch(String(input), init))
    const channels = new ChannelTests({ helper, agentDir, sessionsDir, broadcast: update => windows.broadcast(null, IPC.channelTestUpdate, update) })
    return {
        service,
        channels,
        login(owner: Electron.WebContents, provider: string, method: 'api_key' | 'oauth') {
            const login = helper.login(provider, method)
            owners.set(login, owner)
            // A window closed mid-login leaves nobody to answer its prompts.
            owner.once('destroyed', () => owners.has(login) && helper.cancel(login))
            return login
        },
    }
})()

/** pi's `cacheWarming`, which the gateway follows too (gateway/warm.ts). */
let cacheWarming: CacheWarming = 'streaming'

/**
 * Settings → 路由: routing groups and the local gateway agents reach their models through. Provider
 * keys are pi's, looked up by the provider helper and kept in this process.
 */
const routes = new RoutesService({
    file: path.join(app.getPath('userData'), 'routes.json'),
    helper: {
        routeCatalog: () => providers.service.helper.routeCatalog(),
        routeTarget: (provider, model) => providers.service.helper.routeTarget(provider, model),
    },
    fetch: (input, init) => net.fetch(input instanceof Request ? input : String(input), init),
    onChanged: state => windows.broadcast(null, IPC.routesChanged, state),
    piExtension: path.join(extensionsDir, 'routes.ts'),
    // A warm shows in the thread as pi's own does (entry_appended); the agents' logs do not have it.
    warming: {
        mode: () => cacheWarming,
        prices: priceList,
        warmed: (agentId, entry) => windows.deliver(agentId, IPC.agentEvent, { type: 'entry_appended', entry }),
    },
})

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
    // The setup assistant. A probe asks the login shell again, so agents found after an install
    // show up everywhere (the composer's picker, Settings → Agents).
    ipcMain.handle(IPC.setupProbe, async () => {
        const probe = await probeSetup(liveSetupDeps())
        windows.broadcast(null, IPC.agentsChanged)
        return probe
    })
    ipcMain.handle(IPC.setupInstall, async (_e, id: unknown, size: unknown) => {
        const tool = SETUP_TOOL_IDS.find(t => t === id)
        const command = tool && await installCommand(tool, liveSetupDeps())
        if (!tool || !command)
            throw new Error(tr('这台电脑上没有可用的安装方式', 'No installer for this computer'))
        const s = (size ?? {}) as Record<string, unknown>
        return terminals.create({
            cwd: os.homedir(),
            command,
            label: SETUP_LABELS[tool],
            cols: typeof s.cols === 'number' ? s.cols : undefined,
            rows: typeof s.rows === 'number' ? s.rows : undefined,
        }, 'setup')
    })
    ipcMain.handle(IPC.listSessions, async () => {
        const pi = await listSessions()
        const known = new Set([...store.state.projects, ...pi.map(s => s.cwd)])
        const others = await acp.listSessions(known)
        return [...pi, ...others].sort((a, b) => b.updatedAt - a.updatedAt)
    })
    ipcMain.handle(IPC.readSession, (_e, file: string) => (parseAcpSessionKey(file) ? acp.readSession(file) : readSession(file)))
    ipcMain.handle(IPC.spendLedger, async (_e, days: unknown) => readLedger({ pi: await sessionsDir() }, Date.now() - Math.min(Math.max(Number(days) || 7, 1), 90) * 86_400_000, Object.keys(priceList()).length ? priceList() : await refreshPrices()))
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

    // End-to-end runs skip the setup assistant unless they test it (test/app.ts launch).
    const skipSetup = process.env.PI_GUI_SKIP_SETUP === '1'
    ipcMain.handle(IPC.loadState, (e) => {
        const state = windows.stateFor(e.sender, store.state)
        return skipSetup && !state.setupDone ? { ...state, setupDone: SETUP_VERSION } : state
    })
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
    ipcMain.handle(IPC.importSession, async (e, into: unknown, projects: unknown, file: unknown) => {
        let chosen = file
        if (chosen === undefined) {
            const parent = BrowserWindow.fromWebContents(e.sender)
            const options = { properties: ['openFile'] as 'openFile'[], filters: [{ name: 'pi session', extensions: ['jsonl'] }] }
            const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
            if (result.canceled || !result.filePaths[0])
                return null
            chosen = result.filePaths[0]
        }
        return importSession(chosen, into, projects)
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
            const agentId = await agents.startAcp(acp, kind, options, (spec, launch) => routes.routeAcp(spec, launch, options.route))
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
        const routed = await routes.routePi(options.route)
        const agentId = agents.start(env.env, options, routed ?? {})
        routed?.started(agentId)
        windows.addAgent(agentId, e.sender, options.cwd)
        return agentId
    })
    ipcMain.handle(IPC.routes, () => routes.state())
    ipcMain.handle(IPC.routesSave, (_e, config: unknown) => routes.save(config))
    ipcMain.handle(IPC.routeCatalog, (_e, force: unknown) => routes.catalog(force === true))
    ipcMain.handle(IPC.threadRoute, (_e, agentId: unknown) => routes.threadInfo(String(agentId)))
    ipcMain.handle(IPC.setThreadRoute, (_e, agentId: unknown, route: unknown) => routes.setThread(String(agentId), route))
    ipcMain.handle(IPC.sessionRoute, (_e, key: unknown) => routes.sessionGroup(String(key)))
    ipcMain.handle(IPC.agentChannel, (_e, agent: unknown) => {
        const terminal = TERMINAL_AGENTS.find(a => a === agent)
        return terminal ? routes.channel(terminal) : {}
    })
    ipcMain.handle(IPC.useChannel, (_e, agent: unknown, pick: unknown) => {
        const terminal = TERMINAL_AGENTS.find(a => a === agent)
        const raw = pick && typeof pick === 'object' ? pick as Record<string, unknown> : undefined
        if (!terminal || (raw && (typeof raw.provider !== 'string' || typeof raw.model !== 'string')))
            throw new Error('bad channel')
        return routes.useChannel(terminal, raw ? { provider: String(raw.provider), model: String(raw.model) } : null)
    })
    ipcMain.handle(IPC.setSessionRoute, (_e, key: unknown, group: unknown) => routes.setSessionGroup(String(key), typeof group === 'string' && group ? group : undefined))
    ipcMain.handle(IPC.agentRequest, (_e, agentId: string, command: Record<string, unknown>) => agents.request(agentId, command))
    ipcMain.handle(IPC.agentSend, (_e, agentId: string, record: Record<string, unknown>) => agents.send(agentId, record))
    ipcMain.handle(IPC.agentStop, (_e, agentId: string) => agents.stop(agentId))

    ipcMain.handle(IPC.compactionInfo, (_e, cwd: unknown, modelKey: unknown) =>
        compactionInfo(typeof cwd === 'string' ? cwd : '', typeof modelKey === 'string' ? modelKey : undefined))
    ipcMain.handle(IPC.globalCompaction, (_e, cwd: unknown) => globalCompaction(typeof cwd === 'string' ? cwd : undefined))
    // Every window hears of the write from watchSettings, as of one by pi in a terminal; the writer
    // gets the new state at once.
    ipcMain.handle(IPC.setGlobalCompaction, async (_e, patch: unknown) => {
        await setGlobalCompaction(patch)
        return piSettingsState()
    })
    ipcMain.handle(IPC.piSettings, () => piSettingsState())
    ipcMain.handle(IPC.setCapabilities, async (_e, patch: unknown) => {
        await setCapabilities(patch)
        return piSettingsState()
    })
    ipcMain.handle(IPC.installWebAccess, async () => {
        await installPackage(WEB_ACCESS.source)
        return piSettingsState()
    })
    ipcMain.handle(IPC.setWebAccess, async (_e, enabled: unknown) => {
        await setWebAccess(enabled === true)
        return piSettingsState()
    })
    ipcMain.handle(IPC.setCacheWarming, async (_e, mode: unknown) => {
        await setCacheWarming(mode)
        return piSettingsState()
    })
    ipcMain.handle(IPC.piDefaults, (_e, cwd: unknown) => piDefaults(cwd))
    ipcMain.handle(IPC.piTrust, (_e, cwd: unknown, sessionPath: unknown) => {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || presence.current.some(p => p.bridge && p.session === sessionPath))
            return null
        return providers.service.helper.trustQuestion(cwd)
    })
    ipcMain.handle(IPC.answerPiTrust, (_e, cwd: unknown, label: unknown) => {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd))
            throw new Error('expected a project folder')
        return providers.service.helper.answerTrust(cwd, typeof label === 'string' ? label : undefined)
    })
    ipcMain.handle(IPC.projectTrust, (_e, cwds: unknown) => {
        if (!Array.isArray(cwds) || !cwds.every(cwd => typeof cwd === 'string' && path.isAbsolute(cwd)))
            throw new Error('expected project folders')
        return providers.service.helper.trustState(cwds)
    })
    ipcMain.handle(IPC.setProjectTrust, async (_e, cwd: unknown, decision: unknown) => {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || (decision !== null && typeof decision !== 'boolean'))
            throw new Error('expected a project folder and true, false or null')
        return (await providers.service.helper.setTrust(cwd, decision))[0]
    })
    const scopedModels = async (cwd: unknown) => {
        const patterns = await enabledModels(cwd)
        const found = await providers.service.helper.scopedModels(patterns ?? [])
        // No patterns: every model is in.
        return { patterns, ...found, scoped: patterns ? found.scoped : found.models.map(m => `${m.provider}/${m.id}`) }
    }
    const claudeMcp = async (cwd: unknown) => claudeMcpServers(absolutePath(cwd))
    // An agent's own command (`claude mcp add`, `grok mcp list`); rejects with what it printed when it fails.
    const runCli = async (id: string, args: string[], cwd: string): Promise<string> => {
        const launch = await acp.cli(id)
        try {
            return (await execFileAsync(launch.file, [...launch.args, ...args], { cwd, env: launch.env, timeout: 60_000, windowsVerbatimArguments: launch.windowsVerbatimArguments })).stdout
        }
        catch (error: any) {
            throw new Error(String(error?.stderr || error?.stdout || error?.message || error).trim())
        }
    }
    const runClaude = (args: string[], cwd: string) => runCli('claude', args, cwd)
    const grokMcp = async (cwd: string) => parseGrokMcp(await runCli('grok', GROK_MCP_LIST, cwd))
    ipcMain.handle(IPC.grokMcp, (_e, cwd: unknown) => grokMcp(absolutePath(cwd)))
    ipcMain.handle(IPC.addGrokMcp, async (_e, input: GrokMcpAdd) => {
        const cwd = absolutePath(input?.cwd)
        await runCli('grok', grokMcpAddArgs(input), cwd)
        return grokMcp(cwd)
    })
    ipcMain.handle(IPC.removeGrokMcp, async (_e, cwd: unknown, scope: string, name: string) => {
        await runCli('grok', grokMcpRemoveArgs(scope, name), absolutePath(cwd))
        return grokMcp(absolutePath(cwd))
    })
    ipcMain.handle(IPC.setGrokMcp, async (_e, cwd: unknown, name: string, enabled: unknown) => {
        await runCli('grok', grokMcpEnableArgs(name, enabled), absolutePath(cwd))
        return grokMcp(absolutePath(cwd))
    })
    ipcMain.handle(IPC.piMcp, (_e, cwd: unknown) => piMcpServers(absolutePath(cwd)))
    ipcMain.handle(IPC.addPiMcp, async (_e, input: PiMcpAdd) => {
        const cwd = absolutePath(input?.cwd)
        await runPi(piMcpAddArgs(input), { cwd, timeoutMs: 60_000 })
        return piMcpServers(cwd)
    })
    ipcMain.handle(IPC.removePiMcp, async (_e, cwd: unknown, scope: string, name: string) => {
        await runPi(piMcpRemoveArgs(scope, name), { cwd: absolutePath(cwd), timeoutMs: 60_000 })
        return piMcpServers(absolutePath(cwd))
    })
    ipcMain.handle(IPC.setPiMcp, async (_e, cwd: unknown, scope: string, name: string, patch: { enabled?: unknown, exposure?: unknown }) => {
        await setPiMcp(absolutePath(cwd), scope, name, patch ?? {})
        return piMcpServers(absolutePath(cwd))
    })
    const codexLaunch = () => acp.launch('codex')
    const codexMcp = async (cwd: string) => codexMcpServers(await codexLaunch(), cwd)
    ipcMain.handle(IPC.codexMcp, (_e, cwd: unknown) => codexMcp(absolutePath(cwd)))
    ipcMain.handle(IPC.addCodexMcp, async (_e, input: CodexMcpAdd) => {
        const cwd = absolutePath(input?.cwd)
        await writeCodexMcp(await codexLaunch(), codexServerName(input.name), codexMcpTable(input))
        return codexMcp(cwd)
    })
    ipcMain.handle(IPC.removeCodexMcp, async (_e, cwd: unknown, name: unknown) => {
        await writeCodexMcp(await codexLaunch(), codexServerName(name), null)
        return codexMcp(absolutePath(cwd))
    })
    ipcMain.handle(IPC.codexPlugins, async (_e, cwd: unknown) => codexPlugins(await codexLaunch(), absolutePath(cwd)))
    ipcMain.handle(IPC.changeCodexPlugins, async (_e, cwd: unknown, change: unknown) => changeCodexPlugins(await codexLaunch(), absolutePath(cwd), codexPluginChange(change)))
    ipcMain.handle(IPC.codexFeatures, async () => codexFeatures(await codexLaunch()))
    ipcMain.handle(IPC.setCodexFeature, async (_e, name: unknown, enabled: unknown) => {
        if (typeof enabled !== 'boolean')
            throw new Error('expected true or false')
        const launch = await codexLaunch()
        await setCodexFeature(launch, codexServerName(name), enabled)
        return codexFeatures(launch)
    })
    ipcMain.handle(IPC.codexApps, async () => codexApps(await codexLaunch()))
    ipcMain.handle(IPC.setCodexApp, async (_e, id: unknown, enabled: unknown) => {
        if (typeof enabled !== 'boolean')
            throw new Error('expected true or false')
        const launch = await codexLaunch()
        await setCodexApp(launch, codexServerName(id), enabled)
        return codexApps(launch)
    })
    ipcMain.handle(IPC.codexMemory, async () => codexMemory(await codexLaunch()))
    ipcMain.handle(IPC.resetCodexMemory, async () => {
        const launch = await codexLaunch()
        await resetCodexMemory(launch)
        return codexMemory(launch)
    })
    ipcMain.handle(IPC.claudeMemory, (_e, cwd: unknown) => claudeMemory(absolutePath(cwd)))
    ipcMain.handle(IPC.setClaudeAutoMemory, (_e, enabled: unknown) => setClaudeAutoMemory(enabled))
    ipcMain.handle(IPC.claudeMcp, (_e, cwd: unknown) => claudeMcp(cwd))
    ipcMain.handle(IPC.addClaudeMcp, async (_e, input: ClaudeMcpAdd) => {
        const cwd = absolutePath(input?.cwd)
        await runClaude(mcpAddArgs({ ...input, cwd }), cwd)
        return claudeMcp(cwd)
    })
    ipcMain.handle(IPC.removeClaudeMcp, async (_e, input: ClaudeMcpRemove) => {
        const cwd = absolutePath(input?.cwd)
        await runClaude(mcpRemoveArgs({ ...input, cwd }), cwd)
        return claudeMcp(cwd)
    })
    ipcMain.handle(IPC.scopedModels, (_e, cwd: unknown) => scopedModels(cwd))
    ipcMain.handle(IPC.setScopedModels, async (_e, cwd: unknown, patterns: unknown) => {
        await setEnabledModels(patterns)
        return scopedModels(cwd)
    })
    ipcMain.handle(IPC.piChangelog, () => providers.service.helper.changelog())
    ipcMain.handle(IPC.setDefaultModel, async (_e, cwd: unknown, provider: unknown, model: unknown) => {
        await setDefaultModel(cwd, provider, model)
        return piDefaults(cwd)
    })
    ipcMain.handle(IPC.setDefaultThinkingLevel, async (_e, cwd: unknown, level: unknown) => {
        await setDefaultThinkingLevel(level)
        return piDefaults(cwd)
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
    ipcMain.handle(IPC.skills, () => listSkills())
    ipcMain.handle(IPC.shareSkills, (_e, names: unknown) => shareSkills(Array.isArray(names) ? names.filter(n => typeof n === 'string') : []))
    ipcMain.handle(IPC.worktreeParents, async (_e, cwds: unknown) => {
        const list = cwdList(cwds).slice(0, 500)
        const parents = await Promise.all(list.map(worktreeParent))
        return Object.fromEntries(list.flatMap((cwd, i) => parents[i] ? [[cwd, parents[i]]] : []))
    })
    ipcMain.handle(IPC.createWorktree, (_e, cwd: unknown) => createWorktree(absolutePath(cwd)))
    ipcMain.handle(IPC.applyWorktree, (_e, cwd: unknown) => applyWorktree(absolutePath(cwd)))
    ipcMain.handle(IPC.removeWorktree, (_e, cwd: unknown) => removeWorktree(absolutePath(cwd)))
    ipcMain.handle(IPC.threadTask, (_e, cwd: unknown, messages: unknown, kind: unknown, from: unknown) =>
        threadTask(absolutePath(cwd), Array.isArray(messages) ? messages : [], kind === 'handoff' ? 'handoff' : 'review', String(from ?? '')))

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
    ipcMain.handle(IPC.revealPath, async (_e, target: unknown) => {
        const file = absolutePath(target)
        // A background run must not open the file manager over the user's work; the call is written down for the script to read.
        if (BACKGROUND)
            await appendFile(path.join(app.getPath('userData'), 'revealed.log'), `${file}\n`)
        else
            shell.showItemInFolder(file)
    })
    ipcMain.handle(IPC.listDir, (_e, dir: unknown) => listDir(absolutePath(dir)))
    ipcMain.handle(IPC.readFile, (_e, file: unknown) => readText(absolutePath(file)))
    ipcMain.handle(IPC.realPath, (_e, file: unknown) => realPathOf(absolutePath(file)))
    ipcMain.handle(IPC.projectSources, (_e, root: unknown) => projectSources(absolutePath(root)))
    ipcMain.handle(IPC.writeFile, (_e, file: unknown, text: unknown, options: { expected?: unknown, bom?: unknown } | undefined) => {
        if (typeof text !== 'string')
            throw new Error('expected text')
        return writeText(absolutePath(file), text, { expected: typeof options?.expected === 'string' ? options.expected : null, bom: options?.bom === true })
    })
    // One set of folder watchers per window, gone with it.
    const folderWatches = new Map<number, FolderWatch>()
    ipcMain.on(IPC.watchDirs, (e, dirs: unknown) => {
        const sender = e.sender
        let watch = folderWatches.get(sender.id)
        if (!watch) {
            const created = new FolderWatch(changes => !sender.isDestroyed() && sender.send(IPC.dirsChanged, changes))
            folderWatches.set(sender.id, watch = created)
            sender.once('destroyed', () => {
                created.close()
                folderWatches.delete(sender.id)
            })
        }
        watch.set(cwdList(dirs))
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
    ipcMain.handle(IPC.addChannel, async (_e, agent: unknown, save: unknown) => {
        const raw = save && typeof save === 'object' ? save as Record<string, unknown> : {}
        const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
        const terminal = TERMINAL_AGENTS.find(a => a === agent)
        const apiKey = text(raw.apiKey, 4096)
        if (!terminal || !apiKey)
            throw new Error(tr('填写地址和 key', 'Enter the address and key'))
        const added = await providers.service.addChannel({ baseUrl: text(raw.baseUrl, 2000), api: AGENT_APIS[terminal][0], apiKey, model: text(raw.model, 300) || undefined })
        if ('listError' in added)
            return added
        // Saving re-read the providers' models; the catalog has the new ones once that is done.
        await routes.catalog(true)
        return routes.useChannel(terminal, added)
    })
        ipcMain.handle(IPC.channelModels, (_e, provider: unknown) => providers.channels.models(id(provider)))
    ipcMain.handle(IPC.channelHealth, () => providers.channels.health())
    ipcMain.handle(IPC.channelTest, (_e, provider: unknown, model: unknown, idleMs: unknown) =>
        providers.channels.start(id(provider), id(model), typeof idleMs === 'number' && idleMs > 0 ? Math.min(idleMs, 270_000) : undefined))
    ipcMain.handle(IPC.channelCancel, (_e, test: unknown) => providers.channels.cancel(id(test)))

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

    ipcMain.handle(IPC.browsers, () => browsers.list())
    ipcMain.handle(IPC.browserCreate, (_e, cwd: unknown, url: unknown) => {
        const folder = absolutePath(cwd)
        const tab = browsers.create(folder, 'user', 'user', typeof url === 'string' && url ? parseAddress(url, true) : undefined)
        return browsers.list().find(t => t.id === tab.id)
    })
    ipcMain.handle(IPC.browserClose, (_e, tid: unknown) => browsers.close(tid))
    ipcMain.handle(IPC.browserNavigate, (_e, tid: unknown, input: unknown) => browsers.navigate(tid, typeof input === 'string' ? input.slice(0, 4000) : ''))
    ipcMain.on(IPC.browserGo, (_e, tid: unknown, action: unknown) => {
        if (action === 'back' || action === 'forward' || action === 'reload' || action === 'stop')
            browsers.go(tid, action)
    })
    ipcMain.on(IPC.browserShow, (e, tid: unknown, bounds: unknown) => {
        const b = bounds as Record<string, unknown> | undefined
        const valid = b && [b.x, b.y, b.width, b.height].every(n => typeof n === 'number' && Number.isFinite(n))
        browsers.show(e.sender, typeof tid === 'string' ? tid : null, valid ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } : undefined)
    })
    ipcMain.on(IPC.browserDevTools, (_e, tid: unknown) => browsers.devTools(tid))
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
    void piSettingsState().then(settings => cacheWarming = settings.cacheWarming, () => {})
    watchSettings((settings) => {
        cacheWarming = settings.cacheWarming
        windows.broadcast(null, IPC.piSettingsChanged, settings)
    })
    registerIpc()
    // Before the first window, so the first threads' pi already gets the socket.
    await terminalTools.start().catch(error => console.error('terminal tools:', error))
    await browserTools.start().catch(error => console.error('browser tools:', error))
    windows.restore(savedWindows(state))
    // Warm up env resolution so the first thread starts faster.
    void resolvePiEnv()
    void readPricesFrom(() => providers.service.helper.prices())
    void routes.init()
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
    browserTools.stop()
    browsers.closeAll()
    providers.channels.cancelAll()
    providers.service.helper.stop()
    void Promise.all([windows.prepareQuit(), agents.stopAll(), terminals.closeAll()]).finally(() => routes.shutdown().catch(() => {}).finally(() => app.quit()))
})

app.on('window-all-closed', () => {
    if (windowPlatform.quitWithLastWindow)
        app.quit()
})
