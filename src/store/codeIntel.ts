// What the file editor knows about TypeScript/JavaScript projects (the "standard" and "full" levels of
// Settings → Editor). One Project (src/lib/tsProject.ts) per tsconfig reads its files from disk once (every
// source file the tsconfig covers, not just what the open file imports) and hands them to lite-monaco's TypeScript
// service, which keeps a single file table per language family. The index is made per project (folder), not per file:
// when a project becomes the one shown (`follow`), every tsconfig in it (a monorepo's packages, the configs a solution
// tsconfig references) is indexed in the background, one after the other, before any file is opened. The few most
// recent projects are kept; the others go. Opening a file only finds its tsconfig's index there, or starts it if it
// is not yet. Squiggles wait for the index of their own tsconfig, so a half-read project does not show errors that
// are not there. On top of that this store:
//  - keeps a second copy of the table in a worker (src/lib/tsCheckClient.ts) that does the type checking: the
//    squiggles of open files and the whole-project check never run on the window's thread;
//  - follows the disk: a change in a watched folder re-reads the files, so an agent's edit shows up;
//  - checks the whole project in the background (full level) and keeps the files with errors for the tree;
//  - writes back what a rename or a quick fix changed in files that are not open in an editor.
import type { TsDiagnosticsRequest, TsDiagnosticsResult } from 'lite-monaco'
import type { DirChange, EditorIntel } from '@shared/ipc'
import type { CompilerOptions } from '@/lib/tsCheck'
import type { Config, ProjectFs, TsModule } from '@/lib/tsProject'
import type { FileTab } from './fileTab'
import { getTSService, setTsCompilerOptions, setTsFiles, setTsResolutions } from 'lite-monaco'
import { computed, observable, reaction, runInAction } from 'mobx'
import { toast } from 'sonner'
import { tr } from '@/lib/i18n'
import { OptionState } from '@/lib/tsCheck'
import { tsChecker } from '@/lib/tsCheckClient'
import { checkOptions, dirOf, isNodeModules, loadConfig, Project, slashed, unvpath, vpath } from '@/lib/tsProject'
import { intoComponent, realOfVirtual, VUE_VIRTUAL, vueScript, vueTail } from '@/lib/vueSfc'
import { appStore } from './app'

export type Family = 'typescript' | 'javascript'
/** Where a file is: a tab, or a stand-in for one (the TypeScript text of a Vue component, at `X.vue.ts`). */
export type Where = Pick<FileTab, 'path' | 'cwd'>
export const familyOf = (lang: string): Family => lang === 'javascript' || lang === 'jsx' ? 'javascript' : 'typescript'

/** The project is checked this long after the last change. */
const SCAN_AFTER_MS = 1500
const WRITE_BACK_AFTER_MS = 300
/** A project nobody shows is kept this long, so switching level or tab does not read it all again. */
const KEEP_MS = 8000
const MAX_WATCHED_DIRS = 600
/** Most tsconfigs of a project indexed ahead of any file being opened. */
const MAX_WARM_CONFIGS = 40
/** Projects whose index is kept at once; the least recently shown goes first, unless it has files open. */
const MAX_OPEN_PROJECTS = 3
const SOURCE_FILE = /\.(?:[cm]?tsx?|jsx|[cm]?js|vue)$/
const CHECKED_FILE = /\.[cm]?tsx?$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

export interface ProjectLink {
    /** The open file's text changed (or is first known): read what it imports now. */
    sync: (text: string) => Promise<void>
    /**
     * The file's diagnostics, computed away from the window's thread once the project is indexed.
     * Null while there is nothing to say yet, or when the link is gone.
     */
    check: (req: TsDiagnosticsRequest) => Promise<TsDiagnosticsResult | null>
    release: () => void
}

interface Entry {
    key: string
    family: Family
    /** The project folder (the tab's cwd) it was made for; its entries come and go together. */
    root: string
    project: Project
    /** The compiler options of its tsconfig, as the checker and the editor's service are given them. */
    options: CompilerOptions
    level: 'standard' | 'full'
    links: Set<object>
    /** The first file, its imports, the global declarations. */
    ready: Promise<void>
    /** Every file the project covers is read and handed over (squiggles wait for it). */
    indexed: Promise<void>
    dirty: Set<string> | 'all'
    scanning: boolean
    rescan: boolean
    scanTimer: ReturnType<typeof setTimeout> | undefined
    dropTimer: ReturnType<typeof setTimeout> | undefined
    /** For asking the service anything about the project. */
    session: ReturnType<typeof getTSService> | null
    pending: Set<string>
    flushTimer: ReturnType<typeof setTimeout> | undefined
    lastFocusRead: number
}

/** The compiler options the checker and the editor's service get for a tsconfig. */
function optionsOf(config: Config): CompilerOptions {
    const next: CompilerOptions = { ...checkOptions(config.options) }
    // A tsconfig that does not say `strict` means not strict; the service's own default is strict.
    if (config.path)
        next.strict ??= false
    return next
}

function projectFs(): ProjectFs {
    return {
        read: file => window.pi.readFile(file),
        realPath: file => window.pi.realPath(file),
        sources: root => window.pi.projectSources(root),
        configs: root => window.pi.projectConfigs(root),
        folders: async dir => (await window.pi.listDir(dir)).entries.filter(e => e.dir).map(e => e.name),
    }
}

class CodeIntel {
    /** Project files with errors → how many (full level, found by the background check). */
    problems = observable.map<string, number>({}, { deep: false })
    /** Folders the project follows (the tree's watcher adds them to its own). */
    dirs = observable.box<string[]>([], { deep: false })

    private entries = new Map<string, Entry>()
    /** Projects (folders) being indexed, the least recently shown first. */
    private opened: string[] = []
    /** A token per project whose tsconfigs are being listed and indexed; a different one (or none) means that run should stop. */
    private warmed = new Map<string, symbol>()
    /** The project shown now, and the level it is wanted at. */
    private active: string | null = null
    private tsModule: Promise<TsModule> | null = null
    private serviceOptions = new OptionState()
    /** What was last handed to the service, by family: a difference later is somebody's edit (rename, quick fix). */
    private published = new Map<Family, Record<string, string>>()
    private writeTimers = new Map<Family, ReturnType<typeof setTimeout>>()
    private writing = false
    private writeAgain = new Set<Family>()
    private fs = projectFs()

    /** Files with errors and every folder above them. */
    private readonly problemTree = computed(() => {
        const out = new Set<string>()
        for (const file of this.problems.keys()) {
            for (let p = file; !out.has(p); p = dirOf(p)) {
                out.add(p)
                if (dirOf(p) === p)
                    break
            }
        }
        return out
    })

    hasProblem(path: string): boolean {
        return this.problemTree.get().has(slashed(path))
    }

    problemCount(path: string): number {
        return this.problems.get(slashed(path)) ?? 0
    }

    private loadTs(): Promise<TsModule> {
        this.tsModule ??= import('typescript').then(m => ((m as { default?: TsModule }).default ?? m) as TsModule)
        return this.tsModule
    }

    /**
     * The project for a tab's file, with what the file imports read. `text` is the editor's. Resolves
     * once the file's own imports are there; global declarations and (full level) the rest keep loading.
     */
    async attach(tab: Where, lang: string, level: Exclude<EditorIntel, 'light'>, text: string): Promise<ProjectLink> {
        const family = familyOf(lang)
        const ts = await this.loadTs()
        const path = slashed(tab.path)
        const root = slashed(tab.cwd)
        const config = await loadConfig(ts, this.fs, path, root)
        const mine = this.entryFor(ts, family, config, root, { path, text })
        clearTimeout(mine.dropTimer)
        mine.dropTimer = undefined
        const handle = {}
        mine.links.add(handle)
        mine.session ??= getTSService({ lang: family, fileName: path })
        const stopWatching = mine.session.onProjectChange(() => this.writeBackSoon(family))
        this.applyOptions(family, config)

        // An attach that began before the setting changed must not undo what the new level did.
        if (appStore.editorIntel === level)
            this.setLevel(root, level)
        await mine.ready
        await mine.project.add([{ path, text }])
        this.publish(mine)
        let alive = true
        return {
            sync: async (next) => {
                if (!alive)
                    return
                await mine.project.add([{ path, text: next }])
                if (alive)
                    this.publish(mine)
            },
            check: async (req) => {
                // Squiggles wait for the index: a project that is half read would report every import it has not got to yet.
                await mine.indexed
                if (!alive)
                    return null
                // What the file imports now is read before it is checked, or a new import would flash as missing.
                if (mine.project.files.get(path) !== req.text) {
                    await mine.project.add([{ path, text: req.text }])
                    if (!alive)
                        return null
                    this.publish(mine)
                }
                return tsChecker.check(family, req, mine.options).catch(() => null)
            },
            release: () => {
                if (!alive)
                    return
                alive = false
                tsChecker.forget(family, vpath(path))
                stopWatching()
                mine.links.delete(handle)
                // A project that is shown keeps its index; a file of one that is not goes a while after its last tab.
                if (!mine.links.size && !this.opened.includes(mine.root))
                    mine.dropTimer = setTimeout(() => this.drop(mine), KEEP_MS)
            },
        }
    }

    /** The entry of a tsconfig, made (and its index started) when there is none. `first` is the file whose open brought it about. */
    private entryFor(ts: TsModule, family: Family, config: Config, root: string, first?: { path: string, text: string }): Entry {
        const key = `${family}\0${config.path ?? config.dir}`
        const had = this.entries.get(key)
        if (had)
            return had
        const project = new Project(ts, this.fs, config)
        const entry: Entry = {
            key,
            family,
            root,
            project,
            options: optionsOf(config),
            level: 'standard',
            links: new Set(),
            ready: Promise.resolve(),
            indexed: Promise.resolve(),
            dirty: new Set(),
            scanning: false,
            rescan: false,
            scanTimer: undefined,
            dropTimer: undefined,
            session: null,
            pending: new Set(),
            flushTimer: undefined,
            lastFocusRead: Date.now(),
        }
        this.entries.set(key, entry)
        entry.ready = (async () => {
            if (first) {
                await project.add([first])
                this.publish(entry)
            }
            await project.loadAmbient()
            await project.loadDeclarations()
            this.publish(entry)
        })()
        // The rest of the project, once. An attach never waits for it; squiggles do.
        entry.indexed = entry.ready.then(() => project.loadAll()).catch(() => {}).then(() => {
            if (this.entries.get(key) === entry)
                this.publish(entry)
        })
        return entry
    }

    // -- projects

    /**
     * The window shows `active` (null: none) among `windowProjects`, with the editor at `level`. A shown project is
     * indexed in full; at light nothing is. Only the shown project is checked as a whole (full level).
     */
    follow(active: string | null, windowProjects: string[], level: EditorIntel) {
        this.active = active ? slashed(active) : null
        const mine = new Set(windowProjects.map(slashed))
        for (const root of [...this.opened]) {
            if (level === 'light' || !mine.has(root))
                this.closeProject(root)
        }
        if (level !== 'light' && this.active && mine.has(this.active))
            this.openProject(this.active)
        for (const root of this.opened)
            this.setLevel(root, this.levelFor(root))
    }

    private levelFor(root: string): 'standard' | 'full' {
        return appStore.editorIntel === 'full' && (this.active === null || this.active === root) ? 'full' : 'standard'
    }

    /** Starts indexing every tsconfig of a project folder (once), and keeps it as the most recent. */
    openProject(folder: string) {
        const root = slashed(folder)
        this.opened = [...this.opened.filter(r => r !== root), root]
        // Too many: the least recently shown go, unless a file of theirs is open.
        for (const old of [...this.opened]) {
            if (this.opened.length <= MAX_OPEN_PROJECTS)
                break
            if (old !== root && ![...this.entries.values()].some(e => e.root === old && e.links.size))
                this.closeProject(old)
        }
        if (!this.warmed.has(root)) {
            const token = Symbol(root)
            this.warmed.set(root, token)
            void this.warm(root, token).catch(() => {})
        }
    }

    /** Lets go of a project's index. A tsconfig with an editor still open stays until the editor goes. */
    closeProject(folder: string) {
        const root = slashed(folder)
        this.opened = this.opened.filter(r => r !== root)
        this.warmed.delete(root)
        const gone = [...this.entries.values()].filter(e => e.root === root && !e.links.size)
        for (const entry of gone) {
            clearTimeout(entry.dropTimer)
            this.remove(entry, false)
        }
        if (gone.length)
            this.publishAll()
    }

    /** Which families a tsconfig is indexed for: TypeScript always, JavaScript where it reads JavaScript too (a jsconfig, allowJs, checkJs). */
    private familiesOf(config: Config): Family[] {
        const js = !!config.path && /(?:^|\/)jsconfig\.json$/.test(config.path)
        const reads = !!config.options.allowJs || !!config.options.checkJs
        return [...(js ? [] : ['typescript' as const]), ...(js || reads ? ['javascript' as const] : [])]
    }

    /**
     * Lists the tsconfigs of a project folder and indexes them, nearest to the root first, a solution tsconfig's
     * references too. One at a time: a monorepo is not read in parallel.
     */
    private async warm(root: string, token: symbol) {
        const ts = await this.loadTs()
        const listed = await this.fs.configs(root).catch(() => [] as string[])
        const queue = listed.map(slashed).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
        const seen = new Set<string>()
        while (queue.length && seen.size < MAX_WARM_CONFIGS) {
            const path = queue.shift()!
            if (seen.has(path))
                continue
            seen.add(path)
            const config = await loadConfig(ts, this.fs, path, root, path)
            // The project was let go of while this was reading.
            if (this.warmed.get(root) !== token)
                return
            if (!config.path)
                continue
            queue.push(...config.references)
            for (const family of this.familiesOf(config)) {
                const entry = this.entryFor(ts, family, config, root)
                this.setLevel(root, this.levelFor(root))
                await entry.indexed
                if (this.warmed.get(root) !== token)
                    return
            }
        }
    }

    /** The level for every tsconfig of the folder: the project check runs only at full. */
    private setLevel(root: string, level: Exclude<EditorIntel, 'light'>) {
        for (const entry of this.entries.values()) {
            if (entry.root !== root)
                continue
            if (level === 'standard' && entry.level === 'full') {
                // Back from full: stop checking the whole project; what is read stays, it costs nothing now.
                entry.level = 'standard'
                clearTimeout(entry.scanTimer)
                runInAction(() => {
                    for (const file of entry.project.own())
                        this.problems.delete(realOfVirtual(file))
                })
            }
            else if (level === 'full' && entry.level !== 'full') {
                entry.level = 'full'
                void entry.indexed.then(() => this.markDirty(entry, 'all'))
            }
        }
    }

    /** A file's last tab went and its project is not shown: its index goes. */
    private drop(entry: Entry) {
        entry.dropTimer = undefined
        if (entry.links.size || this.entries.get(entry.key) !== entry || this.opened.includes(entry.root))
            return
        this.remove(entry)
    }

    private remove(entry: Entry, publish = true) {
        clearTimeout(entry.scanTimer)
        clearTimeout(entry.flushTimer)
        this.entries.delete(entry.key)
        runInAction(() => {
            for (const file of entry.project.own())
                this.problems.delete(realOfVirtual(file))
        })
        if (publish)
            this.publish(entry)
    }

    /** Hands every family the files of the entries there are now (after entries went). */
    private publishAll() {
        for (const family of ['typescript', 'javascript'] as const) {
            const table: Record<string, string> = {}
            const pointed: Record<string, Record<string, string>> = {}
            for (const e of this.entries.values()) {
                if (e.family !== family)
                    continue
                Object.assign(table, e.project.output())
                Object.assign(pointed, e.project.resolutions())
            }
            this.hand(family, table, pointed)
        }
        this.updateDirs()
    }

    // -- handing files and options to the service

    private applyOptions(family: Family, config: Config) {
        setTsCompilerOptions(this.serviceOptions.apply(family, optionsOf(config)), { lang: family })
    }

    /** Everything the open projects of a family know, as the service's file table. */
    private publish(entry: Entry) {
        const family = entry.family
        const table: Record<string, string> = {}
        const pointed: Record<string, Record<string, string>> = {}
        for (const e of this.entries.values()) {
            if (e.family !== family)
                continue
            Object.assign(table, e.project.output())
            Object.assign(pointed, e.project.resolutions())
        }
        this.hand(family, table, pointed)
        this.updateDirs()
    }

    private hand(family: Family, table: Record<string, string>, pointed: Record<string, Record<string, string>>) {
        this.published.set(family, table)
        setTsFiles(table, { lang: family })
        setTsResolutions(pointed, { lang: family })
        tsChecker.setFiles(family, table)
        tsChecker.setResolutions(family, pointed)
    }

    private updateDirs() {
        const dirs = new Set<string>()
        for (const e of this.entries.values()) {
            for (const file of e.project.own())
                dirs.add(dirOf(file))
        }
        const list = [...dirs].sort().slice(0, MAX_WATCHED_DIRS)
        if (list.join('\n') !== this.dirs.get().join('\n'))
            runInAction(() => this.dirs.set(list))
    }

    // -- the disk changed

    /** The tree's watcher saw changes; the ones in project files are read again. */
    dirsChanged(changes: DirChange[]) {
        for (const change of changes) {
            const dir = slashed(change.dir)
            for (const entry of this.entries.values()) {
                // An empty name: the folder itself changed, so every file of the project in it.
                const names = change.names.includes('') ? entry.project.own().filter(f => dirOf(f) === dir).map(f => f.slice(dir.length + 1)) : change.names
                for (const name of names) {
                    // A Vue component is held as its TypeScript text.
                    const path = name.endsWith('.vue') ? `${dir}/${name}.ts` : `${dir}/${name}`
                    const known = entry.project.files.has(path) || entry.project.imported(path)
                    // A new file is taken in when the project covers it.
                    const wanted = SOURCE_FILE.test(path.replace(VUE_VIRTUAL, '.vue')) && !isNodeModules(path) && entry.project.config.covers(path.replace(VUE_VIRTUAL, '.vue'))
                    if (known || (change.listed && wanted))
                        entry.pending.add(path)
                }
                if (entry.pending.size) {
                    clearTimeout(entry.flushTimer)
                    entry.flushTimer = setTimeout(() => void this.flush(entry), 150)
                }
            }
        }
    }

    private async flush(entry: Entry) {
        const paths = [...entry.pending]
        entry.pending.clear()
        const changed: string[] = []
        for (const path of paths) {
            if (await entry.project.refresh(path).catch(() => false))
                changed.push(path)
        }
        if (!changed.length || this.entries.get(entry.key) !== entry)
            return
        this.publish(entry)
        const affected = new Set<string>(changed)
        for (const path of changed) {
            for (const importer of entry.project.importers(path))
                affected.add(importer)
        }
        this.markDirty(entry, affected)
    }

    /** The window came back: files may have changed in folders nobody watched (git checkout, a new folder). */
    refocused() {
        void (async () => {
            // One folder listing at a time: a monorepo has many.
            for (const entry of [...this.entries.values()]) {
                if (Date.now() - entry.lastFocusRead < 10_000 || this.entries.get(entry.key) !== entry)
                    continue
                entry.lastFocusRead = Date.now()
                await entry.project.reload().catch(() => {})
                if (this.entries.get(entry.key) !== entry)
                    continue
                this.publish(entry)
                this.markDirty(entry, 'all')
            }
        })()
    }

    // -- the background check

    private markDirty(entry: Entry, what: Set<string> | 'all') {
        if (entry.level !== 'full' || entry.family !== 'typescript')
            return
        if (what === 'all' || entry.dirty === 'all')
            entry.dirty = 'all'
        else
            what.forEach(p => (entry.dirty as Set<string>).add(p))
        clearTimeout(entry.scanTimer)
        entry.scanTimer = setTimeout(() => void this.scan(entry), SCAN_AFTER_MS)
    }

    private async scan(entry: Entry) {
        if (entry.scanning) {
            entry.rescan = true
            return
        }
        entry.scanning = true
        try {
            do {
                entry.rescan = false
                const wanted = entry.dirty === 'all' ? entry.project.own() : [...entry.dirty]
                entry.dirty = new Set()
                const files = wanted.filter(f => CHECKED_FILE.test(f) && !DECLARATION_FILE.test(f) && entry.project.files.has(f))
                // One file at a time: the worker answers the open editors' requests between them.
                for (const file of files) {
                    if (entry.rescan || this.entries.get(entry.key) !== entry)
                        break
                    const count = await this.countIn(entry, file)
                    if (count === null)
                        continue
                    const shown = realOfVirtual(file)
                    runInAction(() => {
                        if (count)
                            this.problems.set(shown, count)
                        else
                            this.problems.delete(shown)
                    })
                }
                // Gone files have nothing to report. A file another tsconfig of the folder holds (a package inside this one's folder) is not gone.
                runInAction(() => {
                    for (const file of this.problems.keys()) {
                        if (file.startsWith(`${entry.project.config.dir}/`) && ![...this.entries.values()].some(e => e.project.files.has(file) || e.project.files.has(`${file}.ts`)))
                            this.problems.delete(file)
                    }
                })
            } while (entry.rescan)
        }
        finally {
            entry.scanning = false
        }
    }

    /** How many problems a file has: null when the checker has no answer. A component counts only what is in its own script. */
    private async countIn(entry: Entry, file: string): Promise<number | null> {
        const text = entry.project.files.get(file)
        const tail = text === undefined || !VUE_VIRTUAL.test(file) ? null : vueTail(text)
        if (!tail) {
            const counted = await tsChecker.count(entry.family, [vpath(file)], entry.options).catch(() => null)
            return counted ? counted[vpath(file)] ?? 0 : null
        }
        // JavaScript in a component is read for its types, not reported on; the part we added is not the user's.
        if (!tail.ts)
            return 0
        const result = await tsChecker.check(entry.family, { fileName: vpath(file), text: text!, mode: 'full', wantTags: false, options: {} }, entry.options).catch(() => null)
        return result ? result.diagnostics.filter(d => d.from < tail.end).length : null
    }

    // -- edits to files that are not open

    private writeBackSoon(family: Family) {
        clearTimeout(this.writeTimers.get(family))
        this.writeTimers.set(family, setTimeout(() => void this.writeBack(family), WRITE_BACK_AFTER_MS))
    }

    /**
     * A rename (or quick fix) in the editor edits other project files in the service's table only.
     * Files with an editor of their own are edited there (and saved by the tab); the rest are written
     * here, as long as the disk still holds what the service was given.
     */
    private async writeBack(family: Family) {
        if (this.writing) {
            this.writeAgain.add(family)
            return
        }
        const table = this.published.get(family)
        const entry = [...this.entries.values()].find(e => e.family === family && e.session)
        if (!table || !entry?.session)
            return
        const session = entry.session
        const edits: { entry: Entry, path: string, was: string, now: string }[] = []
        for (const e of this.entries.values()) {
            if (e.family !== family)
                continue
            for (const path of e.project.own()) {
                const was = table[vpath(path)]
                const now = session.getFileText(vpath(path))
                if (was === undefined || now == null || now === was || appStore.openFiles.some(t => t.path === path && t.view))
                    continue
                edits.push({ entry: e, path, was, now })
            }
        }
        if (!edits.length)
            return
        this.writing = true
        const skipped: string[] = []
        let written = 0
        try {
            for (const edit of edits) {
                // A component is held as its TypeScript text: what was changed in the script goes back into the component.
                const real = realOfVirtual(edit.path)
                const disk = await window.pi.readFile(real).catch(() => null)
                const mapped = disk?.kind === 'text' && real !== edit.path && vueScript(disk.text).code === edit.was ? intoComponent(disk.text, edit.was, edit.now) : null
                const next = real === edit.path ? edit.now : mapped
                if (disk?.kind !== 'text' || next === null || (real === edit.path && disk.text !== edit.was)) {
                    skipped.push(real)
                    continue
                }
                const result = await window.pi.writeFile(real, next, { expected: disk.text, bom: disk.bom }).catch(() => null)
                if (!result?.ok) {
                    skipped.push(real)
                    continue
                }
                const held = real === edit.path ? edit.now : vueScript(next).code
                edit.entry.project.wrote(edit.path, held)
                table[vpath(edit.path)] = held
                written++
                this.markDirty(edit.entry, new Set([edit.path, ...edit.entry.project.importers(edit.path)]))
            }
        }
        finally {
            this.writing = false
        }
        // What could not be written goes back to what the disk has, so the service and the files agree.
        if (skipped.length)
            this.publish(entry)
        if (written)
            toast.success(tr(`已改动 ${written} 个文件`, `Changed ${written} file${written === 1 ? '' : 's'}`))
        if (skipped.length)
            toast.error(tr(`${skipped.length} 个文件在磁盘上已变，没有写入`, `${skipped.length} file${skipped.length === 1 ? '' : 's'} changed on disk and were left alone`), { description: skipped.map(p => p.slice(p.lastIndexOf('/') + 1)).join(', ') })
        for (const again of [...this.writeAgain]) {
            this.writeAgain.delete(again)
            this.writeBackSoon(again)
        }
    }

    // -- jumping

    /**
     * The name or path under `pos` that a Go to Definition would act on, as offsets in `text`: what the editor
     * underlines while ⌘ (Ctrl) is held. Null when there is nothing to go to (also when the service is not up yet).
     */
    definitionSpan(tab: Where, lang: string, text: string, pos: number): { from: number, to: number } | null {
        const session = getTSService({ lang: familyOf(lang), fileName: slashed(tab.path) })
        session.update(text)
        const service = session.service()
        if (!service)
            return null
        try {
            const found = service.getDefinitionAndBoundSpan(vpath(slashed(tab.path)), pos)
            // TS also answers for a path that leads nowhere, marked unverified; and for a declaration, with itself.
            const defs = (found?.definitions ?? []).filter(d => !d.unverified)
            const file = vpath(slashed(tab.path))
            if (!found || !defs.length || defs.every(d => d.fileName === file && d.textSpan.start <= pos && pos < d.textSpan.start + d.textSpan.length))
                return null
            let from = found.textSpan.start
            let to = from + found.textSpan.length
            // A module specifier comes with its quotes; the path inside is what is underlined.
            if (to - from > 2 && /['"`]/.test(text[from]) && text[to - 1] === text[from]) {
                from++
                to--
            }
            return from < to && to <= text.length ? { from, to } : null
        }
        catch {
            return null
        }
    }

    /** Where "go to definition" at `pos` leads when it is not in this file: the real file and line/column; null otherwise. */
    definitionElsewhere(tab: Where, lang: string, text: string, pos: number, opts: { same?: string } = {}): { path: string, line: number, col: number } | null {
        const family = familyOf(lang)
        const session = getTSService({ lang: family, fileName: slashed(tab.path) })
        session.update(text)
        const service = session.service()
        if (!service)
            return null
        let defs: readonly { fileName: string, textSpan: { start: number } }[] = []
        try {
            defs = service.getDefinitionAtPosition(vpath(slashed(tab.path)), pos) ?? service.getTypeDefinitionAtPosition(vpath(slashed(tab.path)), pos) ?? []
        }
        catch {
            return null
        }
        const here = vpath(slashed(tab.path))
        const away = defs.filter(d => vpath(slashed(d.fileName)) !== here)
        // `same`: the file this is a stand-in for. A definition in the stand-in itself is a jump within that file.
        if (opts.same !== undefined && defs.length && !away.length) {
            const body = session.getFileText(here) ?? ''
            const start = defs[0].textSpan.start
            const before = body.slice(0, start)
            return { path: opts.same, line: before.split('\n').length, col: start - (before.lastIndexOf('\n') + 1) + 1 }
        }
        if (!away.length || away.length !== defs.length)
            return null
        const target = away[0]
        const key = vpath(slashed(target.fileName))
        let real = key
        for (const e of this.entries.values()) {
            if (e.project.realOf(key) !== key)
                real = e.project.realOf(key)
        }
        // A stand-in for a file the service cannot read (a stylesheet, an image): the file itself, from its top.
        if (real !== key && !session.getFileText(vpath(real)))
            return { path: unvpath(real), line: 1, col: 1 }
        const body = session.getFileText(key) ?? ''
        // The default export of a component is made up (past the end of its text): the component, from its top.
        const tail = VUE_VIRTUAL.test(key) ? vueTail(body) : null
        if (tail && target.textSpan.start >= tail.end)
            return { path: realOfVirtual(unvpath(real)), line: 1, col: 1 }
        const before = body.slice(0, target.textSpan.start)
        const line = before.split('\n').length
        // A component is held as its TypeScript text, which lines up with the component itself.
        return { path: realOfVirtual(unvpath(real)), line, col: target.textSpan.start - (before.lastIndexOf('\n') + 1) + 1 }
    }
}

export const codeIntel = new CodeIntel()

if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => codeIntel.refocused())
    // A project that is shown is indexed at once, whether or not a file of it is opened.
    reaction(
        () => [appStore.activeProject, appStore.windowProjects.join('\n'), appStore.editorIntel] as const,
        ([active, projects, level]) => codeIntel.follow(active, projects ? projects.split('\n') : [], level),
        { fireImmediately: true },
    )
}
