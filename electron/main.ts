import type { AgentStartOptions, GlobalCompactionPatch, StateSave, ThemePref, WindowBounds, WindowReport } from '@shared/ipc'
import { APP_INFO } from '@shared/app'
import { resolveLang } from '@shared/i18n'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_THEME, IPC, THEME_PREFS } from '@shared/ipc'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron'
import { AgentManager } from './agents'
import { applySave, savedWindows, StateFile } from './appState'
import { gitBranch, gitFileDiff, gitStatus } from './git'
import { mainLang, setMainLang, tr } from './i18n'
import { compactionInfo, globalCompaction, setGlobalCompaction } from './piSettings'
import { resolvePiEnv } from './pi-env'
import { assertInSessionsDir, listSessions, readSession } from './sessions'
import { Windows } from './windows'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// productName "Pi" would move userData to ~/Library/Application Support/Pi; keep the existing
// pi-gui folder so saved projects and tabs survive the rename. PI_GUI_USER_DATA isolates test runs.
app.setPath('userData', process.env.PI_GUI_USER_DATA || path.join(app.getPath('appData'), 'pi-gui'))
app.setName(APP_INFO.name)
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const store = new StateFile(() => path.join(app.getPath('userData'), 'state.json'))

// pi loads capability extensions from real files, so packaged builds keep the pi-capabilities package
// (extensions plus the helpers they import) outside the asar, as Resources/capabilities.
const extensionsDir = app.isPackaged ? path.join(process.resourcesPath, 'capabilities', 'extensions') : path.join(__dirname, '../../packages/capabilities/extensions')

const agents = new AgentManager({
    onEvent: (agentId, event) => windows.deliver(agentId, IPC.agentEvent, event),
    onExit: (agentId, info) => windows.deliver(agentId, IPC.agentExit, info),
}, extensionsDir)

const windows = new Windows({ store, create: createWindow, stopAgent: id => agents.stop(id) })

/** Shown notifications, kept referenced so their click handlers survive garbage collection. */
const notices = new Set<Notification>()

function showNotice(notice: unknown) {
    const n = notice as Record<string, unknown> | null
    if (!n || typeof n.title !== 'string' || typeof n.body !== 'string' || typeof n.key !== 'string' || !Notification.isSupported())
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
    if (n.urgent === true && process.platform === 'darwin')
        app.dock?.bounce('informational')
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
        titleBarStyle: 'hiddenInset',
        // Centred in the 38px main toolbar.
        trafficLightPosition: { x: 14, y: 12 },
        backgroundColor: windowBackground(),
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    })
    win.once('ready-to-show', () => win.show())

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
    ipcMain.handle(IPC.listSessions, () => listSessions())
    ipcMain.handle(IPC.readSession, (_e, file: string) => readSession(file))
    ipcMain.handle(IPC.trashSession, async (_e, file: string) => {
        await assertInSessionsDir(file)
        await shell.trashItem(file)
    })

    ipcMain.handle(IPC.loadState, () => store.state)
    ipcMain.handle(IPC.saveState, (e, save: StateSave) => {
        if (!save || typeof save !== 'object' || !save.prefs || !save.tabs || !save.activeTabs)
            return
        let changed = {}
        const owned = windows.init(e.sender).projects
        const written = store.update((state) => {
            const result = applySave(state, save, owned)
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

    const isDirectory = (dir: string) => stat(dir).then(s => s.isDirectory(), () => false)
    ipcMain.handle(IPC.agentStart, async (e, options: AgentStartOptions) => {
        const env = await resolvePiEnv()
        if (!env.ok)
            throw new Error(env.error)
        if (options.sessionPath)
            await assertInSessionsDir(options.sessionPath)
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
}

/**
 * App menu without a ⌘W "Close Window" item: ⌘W, ⌘T, ⌘1–9 and ⌘\ are tab shortcuts handled by the
 * renderer. Edit roles stay so copy/paste and undo keep working in text fields.
 */
function buildMenu() {
    const isMac = process.platform === 'darwin'
    const settings = {
        label: tr('设置…', 'Settings…'),
        accelerator: 'CmdOrCtrl+,',
        click: () => windows.focusedWebContents()?.send(IPC.openSettings),
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(isMac
            ? [{
                    label: app.name,
                    submenu: [
                        { role: 'about' as const },
                        { type: 'separator' as const },
                        settings,
                        { type: 'separator' as const },
                        { role: 'services' as const },
                        { type: 'separator' as const },
                        { role: 'hide' as const },
                        { role: 'hideOthers' as const },
                        { role: 'unhide' as const },
                        { type: 'separator' as const },
                        { role: 'quit' as const },
                    ],
                }]
            : [{ label: tr('文件', 'File'), submenu: [settings, { type: 'separator' as const }, { role: 'quit' as const }] }]),
        { role: 'editMenu' },
        {
            label: tr('视图', 'View'),
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: tr('窗口', 'Window'),
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                {
                    // WebStorm's "Merge All Project Windows": the other windows' projects join this one.
                    label: tr('合并所有窗口', 'Merge All Windows'),
                    click: () => {
                        const target = windows.focusedWebContents()
                        if (target)
                            void windows.mergeAll(target).catch(error => dialog.showErrorBox(tr('合并窗口失败', 'Could not merge windows'), String(error?.message ?? error)))
                    },
                },
                { role: 'close', label: tr('关闭窗口', 'Close Window'), accelerator: 'CmdOrCtrl+Shift+W' },
                ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
            ],
        },
    ]))
}

app.whenReady().then(async () => {
    // Apply the saved appearance before the window exists so the first frame already matches.
    const state = await store.load()
    applyTheme(state.theme)
    nativeTheme.on('updated', () => {
        for (const w of BrowserWindow.getAllWindows())
            w.setBackgroundColor(windowBackground())
    })
    // Packaged builds take the icon from build/icon.icns; in dev the Dock would show Electron's.
    if (process.platform === 'darwin' && !app.isPackaged)
        app.dock?.setIcon(path.join(__dirname, '../../build/icon.png'))
    applyLang(state.lang)
    registerIpc()
    windows.restore(savedWindows(state))
    // Warm up env resolution so the first thread starts faster.
    void resolvePiEnv()
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
    void Promise.all([windows.prepareQuit(), agents.stopAll()]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        app.quit()
})
