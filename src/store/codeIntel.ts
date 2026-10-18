// What the file editor knows about TypeScript/JavaScript projects (the "standard" and "full" levels of
// Settings → Editor). One Project (src/lib/tsProject.ts) per tsconfig reads what the open files need
// from disk and hands it to lite-monaco's TypeScript service, which keeps a single file table per language
// family. On top of that this store:
//  - follows the disk: a change in a watched folder re-reads the files, so an agent's edit shows up;
//  - checks the whole project in the background (full level) and keeps the files with errors for the tree;
//  - writes back what a rename or a quick fix changed in files that are not open in an editor.
import type { DirChange, EditorIntel } from '@shared/ipc'
import type { Config, ProjectFs, TsModule } from '@/lib/tsProject'
import type { FileTab } from './fileTab'
import { getTSService, setTsCompilerOptions, setTsFiles, setTsResolutions } from 'lite-monaco'
import { computed, observable, runInAction } from 'mobx'
import { toast } from 'sonner'
import { tr } from '@/lib/i18n'
import { checkOptions, dirOf, isNodeModules, loadConfig, Project, slashed, vpath } from '@/lib/tsProject'
import { appStore } from './app'

export type Family = 'typescript' | 'javascript'
export const familyOf = (lang: string): Family => lang === 'javascript' || lang === 'jsx' ? 'javascript' : 'typescript'

/** What lite-monaco's service uses for an option nobody set, to go back to when a project that set it is gone. */
const SERVICE_DEFAULTS: Record<string, unknown> = { strict: true, esModuleInterop: true, allowSyntheticDefaultImports: true, skipLibCheck: true, useDefineForClassFields: true, checkJs: false }

/** The project is checked this long after the last change. */
const SCAN_AFTER_MS = 1500
const WRITE_BACK_AFTER_MS = 300
/** A project nobody shows is kept this long, so switching level or tab does not read it all again. */
const KEEP_MS = 8000
const MAX_WATCHED_DIRS = 600
const SOURCE_FILE = /\.(?:[cm]?tsx?|jsx|[cm]?js)$/
const CHECKED_FILE = /\.[cm]?tsx?$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

export interface ProjectLink {
    /** The open file's text changed (or is first known): read what it imports now. */
    sync: (text: string) => Promise<void>
    release: () => void
}

interface Entry {
    key: string
    family: Family
    project: Project
    level: 'standard' | 'full'
    links: Set<object>
    ready: Promise<void>
    everything: Promise<void> | null
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

function projectFs(): ProjectFs {
    return {
        read: file => window.pi.readFile(file),
        realPath: file => window.pi.realPath(file),
        sources: root => window.pi.projectSources(root),
        folders: async dir => (await window.pi.listDir(dir)).entries.filter(e => e.dir).map(e => e.name),
    }
}

const idle = () => new Promise<void>(resolve => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 400 }) : setTimeout(resolve, 16)))

class CodeIntel {
    /** Project files with errors → how many (full level, found by the background check). */
    problems = observable.map<string, number>({}, { deep: false })
    /** Folders the project follows (the tree's watcher adds them to its own). */
    dirs = observable.box<string[]>([], { deep: false })

    private entries = new Map<string, Entry>()
    private tsModule: Promise<TsModule> | null = null
    private applied = new Map<Family, Set<string>>()
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
    async attach(tab: FileTab, lang: string, level: Exclude<EditorIntel, 'light'>, text: string): Promise<ProjectLink> {
        const family = familyOf(lang)
        const ts = await this.loadTs()
        const path = slashed(tab.path)
        const config = await loadConfig(ts, this.fs, path, slashed(tab.cwd))
        const key = `${family}\0${config.path ?? config.dir}`
        let entry = this.entries.get(key)
        if (!entry) {
            const project = new Project(ts, this.fs, config)
            entry = {
                key,
                family,
                project,
                level: 'standard',
                links: new Set(),
                ready: Promise.resolve(),
                everything: null,
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
            const made = entry
            made.ready = (async () => {
                await project.add([{ path, text }])
                this.publish(made)
                await project.loadAmbient()
                await project.loadDeclarations()
                this.publish(made)
            })()
        }
        const mine = entry
        clearTimeout(mine.dropTimer)
        const handle = {}
        mine.links.add(handle)
        mine.session ??= getTSService({ lang: family, fileName: path })
        const stopWatching = mine.session.onProjectChange(() => this.writeBackSoon(family))
        this.applyOptions(family, config)

        // An attach that began before the setting changed must not undo what the new level did.
        const current = appStore.editorIntel === level
        if (current && level === 'standard' && mine.level === 'full') {
            // Back from full: stop checking the whole project; what is read stays, it costs nothing now.
            mine.level = 'standard'
            mine.everything = null
            clearTimeout(mine.scanTimer)
            runInAction(() => {
                for (const file of mine.project.own())
                    this.problems.delete(file)
            })
        }
        if (current && level === 'full' && !mine.everything) {
            mine.level = 'full'
            mine.everything = mine.ready.then(() => mine.project.loadAll()).then(() => {
                this.publish(mine)
                this.markDirty(mine, 'all')
            })
        }
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
            release: () => {
                if (!alive)
                    return
                alive = false
                stopWatching()
                mine.links.delete(handle)
                if (!mine.links.size)
                    mine.dropTimer = setTimeout(() => this.drop(mine), KEEP_MS)
            },
        }
    }

    private drop(entry: Entry) {
        if (entry.links.size || this.entries.get(entry.key) !== entry)
            return
        clearTimeout(entry.scanTimer)
        clearTimeout(entry.flushTimer)
        this.entries.delete(entry.key)
        runInAction(() => {
            for (const file of entry.project.own())
                this.problems.delete(file)
        })
        this.publish(entry)
    }

    // -- handing files and options to the service

    private applyOptions(family: Family, config: Config) {
        const next: Record<string, unknown> = { ...checkOptions(config.options) }
        // A tsconfig that does not say `strict` means not strict; the service's own default is strict.
        if (config.path)
            next.strict ??= false
        const before = this.applied.get(family) ?? new Set<string>()
        const reset: Record<string, unknown> = {}
        for (const key of before) {
            if (!(key in next))
                reset[key] = SERVICE_DEFAULTS[key]
        }
        this.applied.set(family, new Set(Object.keys(next)))
        setTsCompilerOptions({ ...reset, ...next } as Parameters<typeof setTsCompilerOptions>[0], { lang: family })
    }

    /** Everything the open projects of a family know, as the service's file table. */
    private publish(entry: Entry) {
        const family = entry.family
        const table: Record<string, string> = {}
        for (const e of this.entries.values()) {
            if (e.family === family)
                Object.assign(table, e.project.output())
        }
        const pointed: Record<string, Record<string, string>> = {}
        for (const e of this.entries.values()) {
            if (e.family === family)
                Object.assign(pointed, e.project.resolutions())
        }
        this.published.set(family, table)
        setTsFiles(table, { lang: family })
        setTsResolutions(pointed, { lang: family })
        this.updateDirs()
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
                    const path = `${dir}/${name}`
                    const known = entry.project.files.has(path) || entry.project.imported(path)
                    // A new file is taken in when it is part of what this level reads.
                    const wanted = SOURCE_FILE.test(path) && !isNodeModules(path) && entry.project.config.covers(path) && (entry.level === 'full' || DECLARATION_FILE.test(path))
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
        for (const entry of this.entries.values()) {
            if (entry.level !== 'full' || Date.now() - entry.lastFocusRead < 10_000)
                continue
            entry.lastFocusRead = Date.now()
            void entry.project.reload().then(() => {
                this.publish(entry)
                this.markDirty(entry, 'all')
            })
        }
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
                const session = entry.session
                if (!session)
                    return
                const service = await session.ensure().catch(() => null)
                if (!service)
                    return
                const category = entry.project.ts.DiagnosticCategory.Error
                const wanted = entry.dirty === 'all' ? entry.project.own() : [...entry.dirty]
                entry.dirty = new Set()
                const files = wanted.filter(f => CHECKED_FILE.test(f) && !DECLARATION_FILE.test(f) && entry.project.files.has(f))
                for (const file of files) {
                    if (entry.rescan || this.entries.get(entry.key) !== entry)
                        break
                    await idle()
                    let count = 0
                    try {
                        count = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].filter(d => d.category === category).length
                    }
                    catch {}
                    runInAction(() => {
                        if (count)
                            this.problems.set(file, count)
                        else
                            this.problems.delete(file)
                    })
                }
                // Gone files have nothing to report.
                runInAction(() => {
                    for (const file of this.problems.keys()) {
                        if (!entry.project.files.has(file) && file.startsWith(`${entry.project.config.dir}/`))
                            this.problems.delete(file)
                    }
                })
            } while (entry.rescan)
        }
        finally {
            entry.scanning = false
        }
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
                const disk = await window.pi.readFile(edit.path).catch(() => null)
                if (disk?.kind !== 'text' || disk.text !== edit.was) {
                    skipped.push(edit.path)
                    continue
                }
                const result = await window.pi.writeFile(edit.path, edit.now, { expected: disk.text, bom: disk.bom }).catch(() => null)
                if (!result?.ok) {
                    skipped.push(edit.path)
                    continue
                }
                edit.entry.project.wrote(edit.path, edit.now)
                table[vpath(edit.path)] = edit.now
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

    /** Where "go to definition" at `pos` leads when it is not in this file: the real file and line/column; null otherwise. */
    definitionElsewhere(tab: FileTab, lang: string, text: string, pos: number): { path: string, line: number, col: number } | null {
        const family = familyOf(lang)
        const session = getTSService({ lang: family, fileName: slashed(tab.path) })
        session.update(text)
        const service = session.service()
        if (!service)
            return null
        let defs: readonly { fileName: string, textSpan: { start: number } }[] = []
        try {
            defs = service.getDefinitionAtPosition(slashed(tab.path), pos) ?? service.getTypeDefinitionAtPosition(slashed(tab.path), pos) ?? []
        }
        catch {
            return null
        }
        const here = vpath(slashed(tab.path))
        const away = defs.filter(d => vpath(slashed(d.fileName)) !== here)
        if (!away.length || away.length !== defs.length)
            return null
        const target = away[0]
        const key = vpath(slashed(target.fileName))
        let real = key
        for (const e of this.entries.values()) {
            if (e.project.realOf(key) !== key)
                real = e.project.realOf(key)
        }
        const body = session.getFileText(key) ?? ''
        const before = body.slice(0, target.textSpan.start)
        const line = before.split('\n').length
        return { path: real, line, col: target.textSpan.start - (before.lastIndexOf('\n') + 1) + 1 }
    }
}

export const codeIntel = new CodeIntel()

if (typeof window !== 'undefined')
    window.addEventListener('focus', () => codeIntel.refocused())
