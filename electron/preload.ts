import type { PiBridge } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import { contextBridge, ipcRenderer } from 'electron'

/** Main → renderer push channel; returns the unsubscribe function. */
function listen<A extends unknown[]>(channel: string, listener: (...args: A) => void) {
    const handler = (_e: unknown, ...args: unknown[]) => listener(...(args as A))
    ipcRenderer.on(channel, handler)
    return () => {
        ipcRenderer.off(channel, handler)
    }
}

/** Main → renderer request: the handler's result (or error) goes back on IPC.reply with the request id. */
function answer<A, R>(channel: string, handler: (arg: A) => Promise<R>) {
    return listen(channel, (id: string, arg: A) => {
        handler(arg).then(
            value => ipcRenderer.send(IPC.reply, id, { ok: true, value }),
            error => ipcRenderer.send(IPC.reply, id, { ok: false, error: String(error?.message ?? error) }),
        )
    })
}

// Narrow, typed surface: the renderer never gets raw ipcRenderer access.
const bridge: PiBridge = {
    resolveEnv: () => ipcRenderer.invoke(IPC.resolveEnv),
    listAgents: () => ipcRenderer.invoke(IPC.listAgents),
    installAgent: id => ipcRenderer.invoke(IPC.installAgent, id),
    onAgentsChanged: listener => listen(IPC.agentsChanged, listener),
    setupProbe: () => ipcRenderer.invoke(IPC.setupProbe),
    setupInstall: (id, size) => ipcRenderer.invoke(IPC.setupInstall, id, size),
    listSessions: () => ipcRenderer.invoke(IPC.listSessions),
    readSession: path => ipcRenderer.invoke(IPC.readSession, path),
    spendLedger: days => ipcRenderer.invoke(IPC.spendLedger, days),
    trashSession: (path, options) => ipcRenderer.invoke(IPC.trashSession, path, options),
    searchSessions: query => ipcRenderer.invoke(IPC.searchSessions, query),
    getPresence: () => ipcRenderer.invoke(IPC.presence),
    onPresence: listener => listen(IPC.presence, listener),
    followSession: (path, on) => ipcRenderer.invoke(IPC.followSession, path, on),
    onSessionChanged: listener => listen(IPC.sessionChanged, listener),

    loadState: () => ipcRenderer.invoke(IPC.loadState),
    saveState: state => ipcRenderer.invoke(IPC.saveState, state),
    pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
    onPrefsChanged: listener => listen(IPC.prefsChanged, listener),

    windowInit: () => ipcRenderer.invoke(IPC.windowInit),
    windowReady: () => ipcRenderer.invoke(IPC.windowReady),
    reportWindow: report => ipcRenderer.invoke(IPC.reportWindow, report),
    onWindowProjects: listener => listen(IPC.windowProjects, listener),
    onOpenProjects: listener => listen(IPC.openProjects, listener),
    onSelectProject: listener => listen(IPC.selectProject, listener),
    openProject: cwd => ipcRenderer.invoke(IPC.openProject, cwd),
    attachProject: cwd => ipcRenderer.invoke(IPC.attachProject, cwd),
    detachProject: cwd => ipcRenderer.invoke(IPC.detachProject, cwd),
    closeProject: cwd => ipcRenderer.invoke(IPC.closeProject, cwd),
    mergeAllWindows: () => ipcRenderer.invoke(IPC.mergeAllWindows),
    focusWindow: () => ipcRenderer.invoke(IPC.focusWindow),
    importSession: (into, projects, file) => ipcRenderer.invoke(IPC.importSession, into, projects, file),
    revealSession: (cwd, session, entryId) => ipcRenderer.invoke(IPC.revealSession, cwd, session, entryId),
    onRevealSession: listener => listen(IPC.revealSession, listener),
    onExportProjects: handler => answer(IPC.exportProjects, handler),
    onImportProjects: handler => answer(IPC.importProjects, handler),
    moveTab: move => ipcRenderer.invoke(IPC.moveTab, move),
    onExportThreads: handler => answer(IPC.exportThreads, handler),
    onImportThreads: handler => answer(IPC.importThreads, handler),
    onOpenTabs: listener => listen(IPC.openTabs, listener),

    agentStart: options => ipcRenderer.invoke(IPC.agentStart, options),
    agentRequest: (agentId, command) => ipcRenderer.invoke(IPC.agentRequest, agentId, command),
    agentSend: (agentId, record) => ipcRenderer.invoke(IPC.agentSend, agentId, record),
    agentStop: agentId => ipcRenderer.invoke(IPC.agentStop, agentId),
    onAgentEvent: (listener) => {
        const handler = (_e: unknown, agentId: string, event: any) => listener(agentId, event)
        ipcRenderer.on(IPC.agentEvent, handler)
        return () => ipcRenderer.off(IPC.agentEvent, handler)
    },
    onAgentExit: (listener) => {
        const handler = (_e: unknown, agentId: string, info: any) => listener(agentId, info)
        ipcRenderer.on(IPC.agentExit, handler)
        return () => ipcRenderer.off(IPC.agentExit, handler)
    },
    onOpenSettings: (listener) => {
        const handler = () => listener()
        ipcRenderer.on(IPC.openSettings, handler)
        return () => ipcRenderer.off(IPC.openSettings, handler)
    },

    compactionInfo: (cwd, modelKey) => ipcRenderer.invoke(IPC.compactionInfo, cwd, modelKey),
    globalCompaction: cwd => ipcRenderer.invoke(IPC.globalCompaction, cwd),
    setGlobalCompaction: patch => ipcRenderer.invoke(IPC.setGlobalCompaction, patch),
    piSettings: () => ipcRenderer.invoke(IPC.piSettings),
    setCapabilities: patch => ipcRenderer.invoke(IPC.setCapabilities, patch),
    installWebAccess: () => ipcRenderer.invoke(IPC.installWebAccess),
    setWebAccess: enabled => ipcRenderer.invoke(IPC.setWebAccess, enabled),
    setCacheWarming: mode => ipcRenderer.invoke(IPC.setCacheWarming, mode),
    piDefaults: cwd => ipcRenderer.invoke(IPC.piDefaults, cwd),
    piTrust: (cwd, sessionPath) => ipcRenderer.invoke(IPC.piTrust, cwd, sessionPath),
    answerPiTrust: (cwd, label) => ipcRenderer.invoke(IPC.answerPiTrust, cwd, label),
    projectTrust: cwds => ipcRenderer.invoke(IPC.projectTrust, cwds),
    setProjectTrust: (cwd, decision) => ipcRenderer.invoke(IPC.setProjectTrust, cwd, decision),
    grokMcp: cwd => ipcRenderer.invoke(IPC.grokMcp, cwd),
    addGrokMcp: input => ipcRenderer.invoke(IPC.addGrokMcp, input),
    removeGrokMcp: (cwd, scope, name) => ipcRenderer.invoke(IPC.removeGrokMcp, cwd, scope, name),
    setGrokMcp: (cwd, name, enabled) => ipcRenderer.invoke(IPC.setGrokMcp, cwd, name, enabled),
    piMcp: cwd => ipcRenderer.invoke(IPC.piMcp, cwd),
    addPiMcp: input => ipcRenderer.invoke(IPC.addPiMcp, input),
    removePiMcp: (cwd, scope, name) => ipcRenderer.invoke(IPC.removePiMcp, cwd, scope, name),
    setPiMcp: (cwd, scope, name, patch) => ipcRenderer.invoke(IPC.setPiMcp, cwd, scope, name, patch),
    codexMcp: cwd => ipcRenderer.invoke(IPC.codexMcp, cwd),
    addCodexMcp: input => ipcRenderer.invoke(IPC.addCodexMcp, input),
    removeCodexMcp: (cwd, name) => ipcRenderer.invoke(IPC.removeCodexMcp, cwd, name),
    codexPlugins: cwd => ipcRenderer.invoke(IPC.codexPlugins, cwd),
    changeCodexPlugins: (cwd, change) => ipcRenderer.invoke(IPC.changeCodexPlugins, cwd, change),
    codexFeatures: () => ipcRenderer.invoke(IPC.codexFeatures),
    setCodexFeature: (name, enabled) => ipcRenderer.invoke(IPC.setCodexFeature, name, enabled),
    claudeMemory: cwd => ipcRenderer.invoke(IPC.claudeMemory, cwd),
    setClaudeAutoMemory: enabled => ipcRenderer.invoke(IPC.setClaudeAutoMemory, enabled),
    claudeMcp: cwd => ipcRenderer.invoke(IPC.claudeMcp, cwd),
    addClaudeMcp: input => ipcRenderer.invoke(IPC.addClaudeMcp, input),
    removeClaudeMcp: input => ipcRenderer.invoke(IPC.removeClaudeMcp, input),
    scopedModels: cwd => ipcRenderer.invoke(IPC.scopedModels, cwd),
    setScopedModels: (cwd, patterns) => ipcRenderer.invoke(IPC.setScopedModels, cwd, patterns),
    piChangelog: () => ipcRenderer.invoke(IPC.piChangelog),
    setDefaultModel: (cwd, provider, model) => ipcRenderer.invoke(IPC.setDefaultModel, cwd, provider, model),
    setDefaultThinkingLevel: (cwd, level) => ipcRenderer.invoke(IPC.setDefaultThinkingLevel, cwd, level),
    onPiSettingsChanged: listener => listen(IPC.piSettingsChanged, listener),
    gitStatus: cwd => ipcRenderer.invoke(IPC.gitStatus, cwd),
    gitBranches: cwds => ipcRenderer.invoke(IPC.gitBranches, cwds),
    gitFileDiff: (cwd, path, status) => ipcRenderer.invoke(IPC.gitFileDiff, cwd, path, status),
    gitFileBytes: (cwd, path, status, origPath) => ipcRenderer.invoke(IPC.gitFileBytes, cwd, path, status, origPath),
    gitFileThumbs: (cwd, path, status, origPath) => ipcRenderer.invoke(IPC.gitFileThumbs, cwd, path, status, origPath),
    gitFileEntries: (cwd, path, status, origPath) => ipcRenderer.invoke(IPC.gitFileEntries, cwd, path, status, origPath),
    repoEdits: cwd => ipcRenderer.invoke(IPC.repoEdits, cwd),
    gitDiscard: (cwd, files) => ipcRenderer.invoke(IPC.gitDiscard, cwd, files),
    gitCommit: (cwd, message, paths) => ipcRenderer.invoke(IPC.gitCommit, cwd, message, paths),
    skills: () => ipcRenderer.invoke(IPC.skills),
    shareSkills: names => ipcRenderer.invoke(IPC.shareSkills, names),
    worktreeParents: cwds => ipcRenderer.invoke(IPC.worktreeParents, cwds),
    createWorktree: cwd => ipcRenderer.invoke(IPC.createWorktree, cwd),
    applyWorktree: cwd => ipcRenderer.invoke(IPC.applyWorktree, cwd),
    removeWorktree: cwd => ipcRenderer.invoke(IPC.removeWorktree, cwd),
    threadTask: (cwd, messages, kind, from) => ipcRenderer.invoke(IPC.threadTask, cwd, messages, kind, from),

    openFolder: path => ipcRenderer.invoke(IPC.openFolder, path),
    revealPath: path => ipcRenderer.invoke(IPC.revealPath, path),
    listDir: dir => ipcRenderer.invoke(IPC.listDir, dir),
    readFile: file => ipcRenderer.invoke(IPC.readFile, file),
    writeFile: (file, text, options) => ipcRenderer.invoke(IPC.writeFile, file, text, options),
    watchDirs: dirs => ipcRenderer.send(IPC.watchDirs, dirs),
    onDirsChanged: listener => listen(IPC.dirsChanged, listener),
    missingFolders: paths => ipcRenderer.invoke(IPC.missingFolders, paths),
    setTheme: theme => ipcRenderer.invoke(IPC.setTheme, theme),
    setLang: lang => ipcRenderer.invoke(IPC.setLang, lang),
    openExternal: url => ipcRenderer.invoke(IPC.openExternal, url),

    providers: () => ipcRenderer.invoke(IPC.providers),
    providerLogin: (provider, method) => ipcRenderer.invoke(IPC.providerLogin, provider, method),
    providerAnswer: (login, promptId, value) => ipcRenderer.invoke(IPC.providerAnswer, login, promptId, value),
    providerCancel: login => ipcRenderer.invoke(IPC.providerCancel, login),
    providerLogout: provider => ipcRenderer.invoke(IPC.providerLogout, provider),
    saveEndpoint: save => ipcRenderer.invoke(IPC.saveEndpoint, save),
    removeEndpoint: id => ipcRenderer.invoke(IPC.removeEndpoint, id),
    endpointModels: (baseUrl, api, apiKey, provider) => ipcRenderer.invoke(IPC.endpointModels, baseUrl, api, apiKey, provider),
    addChannel: (agent, save) => ipcRenderer.invoke(IPC.addChannel, agent, save),
    onProviderLogin: listener => listen(IPC.providerLoginUpdate, listener),
    onProvidersChanged: listener => listen(IPC.providersChanged, listener),
    channelModels: provider => ipcRenderer.invoke(IPC.channelModels, provider),
    channelHealth: () => ipcRenderer.invoke(IPC.channelHealth),
    channelTest: (provider, model, idleMs) => ipcRenderer.invoke(IPC.channelTest, provider, model, idleMs),
    channelCancel: test => ipcRenderer.invoke(IPC.channelCancel, test),
    onChannelTest: listener => listen(IPC.channelTestUpdate, listener),
    routes: () => ipcRenderer.invoke(IPC.routes),
    routesSave: config => ipcRenderer.invoke(IPC.routesSave, config),
    routeCatalog: force => ipcRenderer.invoke(IPC.routeCatalog, force),
    threadRoute: agentId => ipcRenderer.invoke(IPC.threadRoute, agentId),
    setThreadRoute: (agentId, route) => ipcRenderer.invoke(IPC.setThreadRoute, agentId, route),
    sessionRoute: key => ipcRenderer.invoke(IPC.sessionRoute, key),
    setSessionRoute: (key, group) => ipcRenderer.invoke(IPC.setSessionRoute, key, group),
    agentChannel: agent => ipcRenderer.invoke(IPC.agentChannel, agent),
    useChannel: (agent, pick) => ipcRenderer.invoke(IPC.useChannel, agent, pick),
    onRoutesChanged: listener => listen(IPC.routesChanged, listener),

    notify: notice => ipcRenderer.invoke(IPC.notify, notice),
    onNotificationClick: (listener) => {
        const handler = (_e: unknown, key: string) => listener(key)
        ipcRenderer.on(IPC.notificationClick, handler)
        return () => ipcRenderer.off(IPC.notificationClick, handler)
    },

    terminals: () => ipcRenderer.invoke(IPC.terminals),
    onTerminals: listener => listen(IPC.terminalsChanged, listener),
    terminalCreate: create => ipcRenderer.invoke(IPC.terminalCreate, create),
    terminalAttach: id => ipcRenderer.invoke(IPC.terminalAttach, id),
    terminalDetach: id => ipcRenderer.send(IPC.terminalDetach, id),
    onTerminalData: listener => listen(IPC.terminalData, listener),
    terminalWrite: (id, data) => ipcRenderer.send(IPC.terminalWrite, id, data),
    terminalResize: (id, cols, rows) => ipcRenderer.send(IPC.terminalResize, id, cols, rows),
    terminalClose: id => ipcRenderer.invoke(IPC.terminalClose, id),
    terminalRestart: id => ipcRenderer.invoke(IPC.terminalRestart, id),
    terminalText: (id, lines) => ipcRenderer.invoke(IPC.terminalText, id, lines),
}

contextBridge.exposeInMainWorld('pi', bridge)
