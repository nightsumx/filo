import type { AppState, GlobalPrefs, SavedWindow, StateSave } from '@shared/ipc'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { GLOBAL_PREF_KEYS } from '@shared/ipc'

export const defaultState = (): AppState => ({ projects: [], hiddenProjects: [], tabs: {}, activeTabs: {}, layout: 'split' })

/**
 * Applies one window's save. Shared settings are taken only where they differ (a window sends just
 * the keys it changed, so a stale window cannot undo another's change); tabs only for the projects
 * the window shows. Tabs of hidden projects are forgotten. Returns the settings that changed, which
 * the other windows need to hear about.
 */
export function applySave(state: AppState, save: StateSave, owned: readonly string[]): { state: AppState, changed: Partial<GlobalPrefs> } {
    const next: AppState = { ...state, tabs: { ...state.tabs }, activeTabs: { ...state.activeTabs } }
    const changed: Partial<GlobalPrefs> = {}
    for (const key of GLOBAL_PREF_KEYS) {
        if (!Object.hasOwn(save.prefs, key) || JSON.stringify(save.prefs[key]) === JSON.stringify(state[key]))
            continue
        Object.assign(next, { [key]: save.prefs[key] })
        Object.assign(changed, { [key]: save.prefs[key] })
    }
    for (const cwd of owned) {
        if (save.tabs[cwd]?.length)
            next.tabs[cwd] = save.tabs[cwd]
        else
            delete next.tabs[cwd]
        if (save.activeTabs[cwd])
            next.activeTabs[cwd] = save.activeTabs[cwd]
        else
            delete next.activeTabs[cwd]
    }
    for (const cwd of next.hiddenProjects ?? []) {
        delete next.tabs[cwd]
        delete next.activeTabs[cwd]
    }
    return { state: next, changed }
}

/** Windows to open on launch. Older state had one window showing activeProject. */
export function savedWindows(state: AppState): SavedWindow[] {
    if (!Array.isArray(state.windows))
        return state.activeProject ? [{ projects: [state.activeProject], active: state.activeProject }] : []
    const windows: SavedWindow[] = []
    // A session is a tab in one window only: the first window listing it keeps it.
    const taken = new Set<string>()
    for (const w of state.windows) {
        const projects = [...new Set((Array.isArray(w?.projects) ? w.projects : []).filter(p => typeof p === 'string' && path.isAbsolute(p)))]
        if (!projects.length)
            continue
        const saved: SavedWindow = { projects, active: projects.includes(w.active ?? '') ? w.active : projects[0] }
        if (w.tabs && typeof w.tabs === 'object') {
            saved.tabs = {}
            saved.activeTabs = {}
            for (const cwd of projects) {
                const list = Array.isArray(w.tabs[cwd]) ? w.tabs[cwd].filter(k => typeof k === 'string' && !taken.has(k)) : []
                list.forEach(k => taken.add(k))
                saved.tabs[cwd] = list
                const active = w.activeTabs?.[cwd]
                if (active && list.includes(active))
                    saved.activeTabs[cwd] = active
            }
        }
        windows.push(saved)
    }
    return windows
}

/** A project's tabs across the windows showing it, in window order, each session once. */
export function unionTabs(lists: string[][]): string[] {
    return [...new Set(lists.flat())]
}

/**
 * The state one window starts from: its own tabs where main has them, else each project's tabs
 * less the sessions other windows show (a session is a tab in one window only).
 */
export function windowState(state: AppState, own: Pick<SavedWindow, 'tabs' | 'activeTabs'>, elsewhere: ReadonlySet<string>): AppState {
    const tabs: Record<string, string[]> = {}
    const activeTabs: Record<string, string> = {}
    for (const [cwd, list] of Object.entries(state.tabs)) {
        const kept = list.filter(k => !elsewhere.has(k))
        if (kept.length)
            tabs[cwd] = kept
    }
    for (const [cwd, key] of Object.entries(state.activeTabs)) {
        if (tabs[cwd]?.includes(key))
            activeTabs[cwd] = key
    }
    for (const [cwd, list] of Object.entries(own.tabs ?? {})) {
        tabs[cwd] = list
        if (own.activeTabs?.[cwd])
            activeTabs[cwd] = own.activeTabs[cwd]
        else
            delete activeTabs[cwd]
    }
    return { ...state, tabs, activeTabs }
}

/** state.json, owned by the main process; every window reads and writes through it. */
export class StateFile {
    state: AppState = defaultState()
    private writing: Promise<void> = Promise.resolve()

    constructor(private file: () => string) {}

    async load(): Promise<AppState> {
        try {
            this.state = { ...defaultState(), ...JSON.parse(await readFile(this.file(), 'utf8')) }
        }
        catch {
            this.state = defaultState()
        }
        return this.state
    }

    update(change: (state: AppState) => AppState): Promise<void> {
        this.state = change(this.state)
        return this.write()
    }

    // Saves arrive in bursts (close tab, switch project, ...). Concurrent writeFile calls on one
    // path can finish out of order, so writes are queued and each goes through a temp file + rename.
    private write(): Promise<void> {
        this.writing = this.writing.catch(() => {}).then(async () => {
            const json = JSON.stringify(this.state, null, 2)
            const file = this.file()
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(`${file}.tmp`, json)
            await rename(`${file}.tmp`, file)
        })
        return this.writing
    }
}
