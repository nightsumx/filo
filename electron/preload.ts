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
    listSessions: () => ipcRenderer.invoke(IPC.listSessions),
    readSession: path => ipcRenderer.invoke(IPC.readSession, path),
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
    onPiSettingsChanged: listener => listen(IPC.piSettingsChanged, listener),
    gitStatus: cwd => ipcRenderer.invoke(IPC.gitStatus, cwd),
    gitBranches: cwds => ipcRenderer.invoke(IPC.gitBranches, cwds),
    gitFileDiff: (cwd, path, status) => ipcRenderer.invoke(IPC.gitFileDiff, cwd, path, status),
    gitFileBytes: (cwd, path, status, origPath) => ipcRenderer.invoke(IPC.gitFileBytes, cwd, path, status, origPath),
    repoEdits: cwd => ipcRenderer.invoke(IPC.repoEdits, cwd),
    gitDiscard: (cwd, files) => ipcRenderer.invoke(IPC.gitDiscard, cwd, files),
    gitCommit: (cwd, message, paths) => ipcRenderer.invoke(IPC.gitCommit, cwd, message, paths),

    openFolder: path => ipcRenderer.invoke(IPC.openFolder, path),
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
    onProviderLogin: listener => listen(IPC.providerLoginUpdate, listener),
    onProvidersChanged: listener => listen(IPC.providersChanged, listener),

    notify: notice => ipcRenderer.invoke(IPC.notify, notice),
    onNotificationClick: (listener) => {
        const handler = (_e: unknown, key: string) => listener(key)
        ipcRenderer.on(IPC.notificationClick, handler)
        return () => ipcRenderer.off(IPC.notificationClick, handler)
    },
}

contextBridge.exposeInMainWorld('pi', bridge)
