// The file tree of the project tool window: folder listings loaded on expand, which folders are
// expanded (remembered per machine, like WebStorm's tree state), the selection, and the folder
// watches that keep the tree and the open editor tabs in step with the disk.
import type { DirEntry, DirListing } from '@shared/ipc'
import type { FileMark } from '@/lib/fileMarks'
import { basename } from '@/lib/utils'
import { comparer, makeAutoObservable, observable, reaction, runInAction } from 'mobx'
import { insideOf, joinPath, parentPath, pathParts } from '@/platform'
import { appStore } from './app'

const EXPANDED_KEY = 'filo.tree.expanded'
/** Remembered expanded folders, across projects. */
const MAX_REMEMBERED = 1000
/** git status for the tree's colours waits for bursts of changes (an agent editing) to settle. */
const GIT_SETTLE_MS = 600

export interface TreeRow {
    path: string
    name: string
    /** The project folder this row is under. */
    root: string
    depth: number
    dir: boolean
    ignored: boolean
    link: boolean
    expanded: boolean
    /** A project's own row. */
    isRoot: boolean
    /** A "N more" row standing in for entries past the listing cap. */
    more?: number
}

function loadExpanded(): string[] {
    try {
        const list = JSON.parse(globalThis.window?.localStorage?.getItem(EXPANDED_KEY) ?? '[]')
        return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
    }
    catch {
        return []
    }
}

class FileTreeStore {
    /** Folder → its entries, once listed. */
    listings = observable.map<string, DirListing>([], { deep: false })
    /** Folders whose listing failed (unreadable, gone). */
    errors = observable.map<string, string>()
    expanded = observable.set<string>(loadExpanded())
    selected: string | null = null
    /** The selection was moved by "locate": the view scrolls it into the middle once. */
    revealing = false
    /** Bumps once changes settle; the tree refetches git status on it. */
    gitTick = 0
    /** git colours per project root, set by the tree view. */
    marks = observable.map<string, Map<string, FileMark>>([], { deep: false })

    private loading = new Map<string, Promise<void>>()
    private again = new Set<string>()
    private gitTimer: ReturnType<typeof setTimeout> | null = null
    private started = false

    constructor() {
        makeAutoObservable<this, 'loading' | 'again' | 'gitTimer' | 'started'>(this, { loading: false, again: false, gitTimer: false, started: false }, { autoBind: true })
    }

    /** Starts watching; called once the app store knows the window's projects. */
    init() {
        if (this.started)
            return
        this.started = true
        window.pi.onDirsChanged(changes => runInAction(() => {
            for (const change of changes) {
                if (change.listed && this.listings.has(change.dir))
                    void this.load(change.dir)
                for (const file of appStore.openFiles) {
                    if (parentPath(file.path) === change.dir && (change.names.includes(file.name) || change.names.includes('')))
                        void file.reload()
                }
            }
            this.settleGit()
        }))
        reaction(() => this.watchedDirs, dirs => window.pi.watchDirs(dirs), { fireImmediately: true, equals: comparer.structural })
        reaction(() => [...this.expanded], (list) => {
            globalThis.window?.localStorage?.setItem(EXPANDED_KEY, JSON.stringify(list.slice(-MAX_REMEMBERED)))
        }, { delay: 300 })
        // Back on screen: listings may be stale (nothing watched them while hidden).
        reaction(() => this.shown, (shown) => {
            if (shown)
                this.refreshLoaded()
        })
        window.addEventListener('focus', () => {
            if (this.shown)
                this.refreshLoaded()
        })
    }

    get shown(): boolean {
        return appStore.sidebarOpen && appStore.sidebarView === 'files'
    }

    get roots(): string[] {
        return appStore.windowProjects
    }

    /** Expanded folders on screen (every folder above them expanded too), roots included. */
    get visibleDirs(): string[] {
        const out: string[] = []
        const walk = (dir: string) => {
            out.push(dir)
            for (const entry of this.listings.get(dir)?.entries ?? []) {
                const path = joinPath(dir, entry.name)
                if (entry.dir && this.expanded.has(path))
                    walk(path)
            }
        }
        for (const root of this.roots) {
            if (this.expanded.has(root))
                walk(root)
        }
        return out
    }

    /** The tree's folders while it is on screen, and the folders of open files always. */
    get watchedDirs(): string[] {
        const dirs = new Set(this.shown ? this.visibleDirs : [])
        for (const file of appStore.openFiles)
            dirs.add(parentPath(file.path))
        return [...dirs].sort()
    }

    /** The rows on screen, flattened in display order. */
    get rows(): TreeRow[] {
        const rows: TreeRow[] = []
        const walk = (dir: string, root: string, depth: number) => {
            const listing = this.listings.get(dir)
            for (const entry of listing?.entries ?? []) {
                const path = joinPath(dir, entry.name)
                const expanded = entry.dir && this.expanded.has(path)
                rows.push(rowOf(entry, path, root, depth, expanded))
                if (expanded)
                    walk(path, root, depth + 1)
            }
            if (listing?.more)
                rows.push({ path: `${dir}\0more`, name: '', root, depth, dir: false, ignored: true, link: false, expanded: false, isRoot: false, more: listing.more })
        }
        for (const root of this.roots) {
            const expanded = this.expanded.has(root)
            rows.push({ path: root, name: basename(root), root, depth: 0, dir: true, ignored: false, link: false, expanded, isRoot: true })
            if (expanded)
                walk(root, root, 1)
        }
        return rows
    }

    /** Lists a folder (again). A request while one runs is queued behind it, never dropped. */
    load(dir: string): Promise<void> {
        const running = this.loading.get(dir)
        if (running) {
            this.again.add(dir)
            return running
        }
        const run = window.pi.listDir(dir).then(
            listing => runInAction(() => {
                this.listings.set(dir, listing)
                this.errors.delete(dir)
            }),
            (error: Error) => runInAction(() => {
                this.listings.delete(dir)
                this.errors.set(dir, error.message)
            }),
        ).finally(() => {
            this.loading.delete(dir)
            if (this.again.delete(dir))
                void this.load(dir)
        })
        this.loading.set(dir, run)
        return run
    }

    /** Lists the expanded folders on screen that are not listed yet. */
    ensureLoaded() {
        for (const dir of this.visibleDirs) {
            if (!this.listings.has(dir) && !this.loading.has(dir) && !this.errors.has(dir))
                void this.load(dir)
        }
    }

    refreshLoaded() {
        for (const dir of this.visibleDirs)
            void this.load(dir)
        this.settleGit()
    }

    toggle(path: string, open?: boolean) {
        const next = open ?? !this.expanded.has(path)
        if (next) {
            this.expanded.add(path)
            if (!this.listings.has(path))
                void this.load(path)
        }
        else {
            this.expanded.delete(path)
        }
    }

    /** Folds every folder of every project. */
    collapseAll() {
        this.expanded.clear()
    }

    select(path: string | null) {
        this.selected = path
    }

    /** Expands the folders down to `path` (listing them on the way) and selects it. */
    async reveal(path: string, root: string) {
        const relative = insideOf(path, root)
        if (relative === undefined)
            return
        const chain = [root]
        for (const part of pathParts(relative).slice(0, -1))
            chain.push(joinPath(chain[chain.length - 1], part))
        for (const dir of chain) {
            runInAction(() => this.expanded.add(dir))
            if (!this.listings.has(dir))
                await this.load(dir)
        }
        runInAction(() => {
            this.selected = path
            this.revealing = true
        })
    }

    revealDone() {
        this.revealing = false
    }

    private settleGit() {
        if (this.gitTimer)
            clearTimeout(this.gitTimer)
        this.gitTimer = setTimeout(() => runInAction(() => {
            this.gitTimer = null
            this.gitTick++
        }), GIT_SETTLE_MS)
    }

    setMarks(root: string, marks: Map<string, FileMark>) {
        this.marks.set(root, marks)
    }
}

function rowOf(entry: DirEntry, path: string, root: string, depth: number, expanded: boolean): TreeRow {
    return { path, name: entry.name, root, depth, dir: entry.dir, ignored: entry.ignored, link: !!entry.link, expanded, isRoot: false }
}

export const fileTreeStore = new FileTreeStore()
