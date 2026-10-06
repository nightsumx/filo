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
    const seen = new Set<string>()
    const windows: SavedWindow[] = []
    for (const w of state.windows) {
        // A project shows in one window only.
        const projects = (Array.isArray(w?.projects) ? w.projects : []).filter(p => typeof p === 'string' && path.isAbsolute(p) && !seen.has(p))
        projects.forEach(p => seen.add(p))
        if (projects.length)
            windows.push({ projects, active: projects.includes(w.active ?? '') ? w.active : projects[0] })
    }
    return windows
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
