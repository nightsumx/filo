import type { PiBridge } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import { contextBridge, ipcRenderer } from 'electron'

// Narrow, typed surface: the renderer never gets raw ipcRenderer access.
const bridge: PiBridge = {
    resolveEnv: () => ipcRenderer.invoke(IPC.resolveEnv),
    listSessions: () => ipcRenderer.invoke(IPC.listSessions),
    readSession: path => ipcRenderer.invoke(IPC.readSession, path),
    trashSession: path => ipcRenderer.invoke(IPC.trashSession, path),

    loadState: () => ipcRenderer.invoke(IPC.loadState),
    saveState: state => ipcRenderer.invoke(IPC.saveState, state),
    pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),

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
    gitStatus: cwd => ipcRenderer.invoke(IPC.gitStatus, cwd),
    gitBranches: cwds => ipcRenderer.invoke(IPC.gitBranches, cwds),
    gitFileDiff: (cwd, path, status) => ipcRenderer.invoke(IPC.gitFileDiff, cwd, path, status),

    openFolder: path => ipcRenderer.invoke(IPC.openFolder, path),
    missingFolders: paths => ipcRenderer.invoke(IPC.missingFolders, paths),
    setTheme: theme => ipcRenderer.invoke(IPC.setTheme, theme),
    setLang: lang => ipcRenderer.invoke(IPC.setLang, lang),
    openExternal: url => ipcRenderer.invoke(IPC.openExternal, url),

    notify: notice => ipcRenderer.invoke(IPC.notify, notice),
    onNotificationClick: (listener) => {
        const handler = (_e: unknown, key: string) => listener(key)
        ipcRenderer.on(IPC.notificationClick, handler)
        return () => ipcRenderer.off(IPC.notificationClick, handler)
    },
    setBadge: count => ipcRenderer.invoke(IPC.setBadge, count),
}

contextBridge.exposeInMainWorld('pi', bridge)
