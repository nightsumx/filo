import type { AgentStartOptions, AppState, ThemePref } from '@shared/ipc'
import { APP_INFO } from '@shared/app'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_THEME, IPC, THEME_PREFS } from '@shared/ipc'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron'
import { AgentManager } from './agents'
import { gitBranch, gitFileDiff, gitStatus } from './git'
import { compactionInfo, globalCompaction, setGlobalCompaction } from './piSettings'
import { resolvePiEnv } from './pi-env'
import { assertInSessionsDir, listSessions, readSession } from './sessions'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// productName "Pi" would move userData to ~/Library/Application Support/Pi; keep the existing
// pi-gui folder so saved projects and tabs survive the rename. PI_GUI_USER_DATA isolates test runs.
app.setPath('userData', process.env.PI_GUI_USER_DATA || path.join(app.getPath('appData'), 'pi-gui'))
app.setName(APP_INFO.name)
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const statePath = () => path.join(app.getPath('userData'), 'state.json')

let win: BrowserWindow | null = null

// pi loads capability extensions from real files, so packaged builds keep them outside the asar.
const extensionsDir = app.isPackaged ? path.join(process.resourcesPath, 'extensions') : path.join(__dirname, '../../extensions')

const agents = new AgentManager({
    onEvent: (agentId, event) => win?.webContents.send(IPC.agentEvent, agentId, event),
    onExit: (agentId, info) => win?.webContents.send(IPC.agentExit, agentId, info),
}, extensionsDir)

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
    shown.on('click', () => {
        drop()
        if (win) {
            if (win.isMinimized())
                win.restore()
            win.show()
            win.focus()
            win.webContents.send(IPC.notificationClick, key)
        }
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

function createWindow() {
    win = new BrowserWindow({
        width: 1360,
        height: 880,
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
    win.once('ready-to-show', () => win?.show())

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
        void win.loadFile(path.join(__dirname, '../../dist/index.html'))
}

const defaultState = (): AppState => ({ projects: [], hiddenProjects: [], tabs: {}, activeTabs: {}, layout: 'split' })

async function loadState(): Promise<AppState> {
    try {
        return { ...defaultState(), ...JSON.parse(await readFile(statePath(), 'utf8')) }
    }
    catch {
        return defaultState()
    }
}

function registerIpc() {
    ipcMain.handle(IPC.resolveEnv, () => resolvePiEnv())
    ipcMain.handle(IPC.listSessions, () => listSessions())
    ipcMain.handle(IPC.readSession, (_e, file: string) => readSession(file))
    ipcMain.handle(IPC.trashSession, async (_e, file: string) => {
        await assertInSessionsDir(file)
        await shell.trashItem(file)
    })

    ipcMain.handle(IPC.loadState, () => loadState())
    // Saves arrive in bursts (close tab, switch project, ...). Concurrent writeFile calls on one
    // path can finish out of order, so writes are queued and each goes through a temp file + rename.
    let saving: Promise<void> = Promise.resolve()
    ipcMain.handle(IPC.saveState, (_e, state: AppState) => {
        const json = JSON.stringify(state, null, 2)
        saving = saving.catch(() => {}).then(async () => {
            const file = statePath()
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(`${file}.tmp`, json)
            await rename(`${file}.tmp`, file)
        })
        return saving
    })
    ipcMain.handle(IPC.pickFolder, async () => {
        const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
        return result.canceled ? null : result.filePaths[0] ?? null
    })

    const isDirectory = (dir: string) => stat(dir).then(s => s.isDirectory(), () => false)
    ipcMain.handle(IPC.agentStart, async (_e, options: AgentStartOptions) => {
        const env = await resolvePiEnv()
        if (!env.ok)
            throw new Error(env.error)
        if (options.sessionPath)
            await assertInSessionsDir(options.sessionPath)
        // spawn reports a missing cwd as "spawn <node> ENOENT", which reads like node is missing.
        if (!(await isDirectory(options.cwd)))
            throw new Error(`项目目录不存在：${options.cwd}`)
        return agents.start(env.env, options)
    })
    ipcMain.handle(IPC.agentRequest, (_e, agentId: string, command: Record<string, unknown>) => agents.request(agentId, command))
    ipcMain.handle(IPC.agentSend, (_e, agentId: string, record: Record<string, unknown>) => agents.send(agentId, record))
    ipcMain.handle(IPC.agentStop, (_e, agentId: string) => agents.stop(agentId))

    ipcMain.handle(IPC.compactionInfo, (_e, cwd: unknown, modelKey: unknown) =>
        compactionInfo(typeof cwd === 'string' ? cwd : '', typeof modelKey === 'string' ? modelKey : undefined))
    ipcMain.handle(IPC.globalCompaction, (_e, cwd: unknown) => globalCompaction(typeof cwd === 'string' ? cwd : undefined))
    ipcMain.handle(IPC.setGlobalCompaction, (_e, patch: unknown) => setGlobalCompaction(patch))
    ipcMain.handle(IPC.gitStatus, (_e, cwd: string) => gitStatus(cwd))
    ipcMain.handle(IPC.gitBranches, async (_e, cwds: unknown) => {
        const list = Array.isArray(cwds) ? cwds.filter((c): c is string => typeof c === 'string' && path.isAbsolute(c)).slice(0, 200) : []
        return Object.fromEntries(await Promise.all(list.map(async cwd => [cwd, await gitBranch(cwd)] as const)))
    })
    ipcMain.handle(IPC.gitFileDiff, (_e, cwd: string, file: string, status: string) => gitFileDiff(cwd, file, status))

    ipcMain.handle(IPC.setTheme, (_e, theme: unknown) => applyTheme(theme))
    ipcMain.handle(IPC.missingFolders, async (_e, paths: unknown) => {
        const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).slice(0, 500) : []
        const exists = await Promise.all(list.map(isDirectory))
        return list.filter((_, i) => !exists[i])
    })
    ipcMain.handle(IPC.openFolder, async (_e, folder: string) => {
        const error = await shell.openPath(folder)
        if (error)
            throw new Error(error)
    })
    ipcMain.handle(IPC.notify, (_e, notice: unknown) => showNotice(notice))
    ipcMain.handle(IPC.setBadge, (_e, count: unknown) => {
        app.setBadgeCount(Number.isInteger(count) && (count as number) > 0 ? Math.min(count as number, 999) : 0)
    })
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
        label: '设置…',
        accelerator: 'CmdOrCtrl+,',
        click: () => win?.webContents.send(IPC.openSettings),
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
            : [{ label: '文件', submenu: [settings, { type: 'separator' as const }, { role: 'quit' as const }] }]),
        { role: 'editMenu' },
        {
            label: '视图',
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
            label: '窗口',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
            ],
        },
    ]))
}

app.whenReady().then(async () => {
    // Apply the saved appearance before the window exists so the first frame already matches.
    applyTheme((await loadState()).theme)
    nativeTheme.on('updated', () => win?.setBackgroundColor(windowBackground()))
    // Packaged builds take the icon from build/icon.icns; in dev the Dock would show Electron's.
    if (process.platform === 'darwin' && !app.isPackaged)
        app.dock?.setIcon(path.join(__dirname, '../../build/icon.png'))
    app.setAboutPanelOptions({
        applicationName: APP_INFO.name,
        applicationVersion: app.getVersion(),
        // Second line of the macOS About panel.
        version: APP_INFO.tagline,
        credits: APP_INFO.description,
        copyright: `© ${new Date().getFullYear()} ${APP_INFO.author}`,
        website: APP_INFO.homepage,
        iconPath: path.join(__dirname, '../../build/icon.png'),
    })
    buildMenu()
    registerIpc()
    createWindow()
    // Warm up env resolution so the first thread starts faster.
    void resolvePiEnv()
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow()
    })
})

let quitting = false
app.on('before-quit', (event) => {
    if (quitting)
        return
    quitting = true
    event.preventDefault()
    void agents.stopAll().finally(() => app.quit())
})

app.on('window-all-closed', () => {
    win = null
    if (process.platform !== 'darwin')
        app.quit()
})
