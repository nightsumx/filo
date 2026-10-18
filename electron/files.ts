// The project tool window's file tree and the editor tabs: list a folder, read and write a text
// file, and watch the folders on screen. Pure UI over the user's files; pi is not involved.
import type { DirChange, DirEntry, DirListing, FileRead, FileWrite } from '@shared/ipc'
import type { Dirent, FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** Bigger files open as "too large" rather than in the editor. */
export const MAX_EDIT_BYTES = 8 * 1024 * 1024
/** A folder shows this many entries at most (the rest is counted). */
export const MAX_DIR_ENTRIES = 10_000
/** Never listed, as in WebStorm's default "ignored files and folders". */
const HIDDEN = new Set(['.git', '.DS_Store'])

const BOM = '\uFEFF'

/** Names (of entries in `dir`) that git ignores; none outside a repository. */
function gitIgnored(dir: string, names: string[]): Promise<Set<string>> {
    if (!names.length)
        return Promise.resolve(new Set())
    return new Promise((resolve) => {
        // execFile with an argument array; names go in on stdin, NUL-separated (no shell, no quoting).
        const child = execFile('git', ['check-ignore', '-z', '--stdin'], { cwd: dir, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => {
            // Exit 1 means "nothing ignored", 128 "not a repository": both leave stdout empty.
            resolve(new Set(String(stdout ?? '').split('\0').filter(Boolean)))
        })
        child.stdin?.on('error', () => {})
        child.stdin?.end(names.map(n => `${n}\0`).join(''))
    })
}

async function entryOf(dir: string, dirent: Dirent): Promise<DirEntry> {
    if (!dirent.isSymbolicLink())
        return { name: dirent.name, dir: dirent.isDirectory(), ignored: false }
    // A link shows as what it points to; a dangling one as a file.
    const target = await stat(path.join(dir, dirent.name)).catch(() => null)
    return { name: dirent.name, dir: !!target?.isDirectory(), ignored: false, link: true }
}

/** Folders first, then by name as people read it (a2 before a10, case ignored), like WebStorm. */
export function compareEntries(a: DirEntry, b: DirEntry): number {
    if (a.dir !== b.dir)
        return a.dir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export async function listDir(dir: string): Promise<DirListing> {
    const dirents = (await readdir(dir, { withFileTypes: true })).filter(d => !HIDDEN.has(d.name))
    const entries = (await Promise.all(dirents.map(d => entryOf(dir, d)))).sort(compareEntries)
    const shown = entries.slice(0, MAX_DIR_ENTRIES)
    // git wants folders with a trailing slash to match "dir/" patterns; a link with one is "beyond a
    // symbolic link", which stops check-ignore for every name after it.
    const asked = (e: DirEntry) => (e.dir && !e.link ? `${e.name}/` : e.name)
    const ignored = await gitIgnored(dir, shown.map(asked))
    for (const entry of shown)
        entry.ignored = ignored.has(asked(entry))
    return { entries: shown, more: entries.length - shown.length }
}

/** Text when the bytes are UTF-8 without NULs; anything else is binary for the editor. */
export function decodeText(bytes: Uint8Array): { text: string, bom: boolean } | null {
    if (bytes.subarray(0, 8000).includes(0))
        return null
    let text: string
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    }
    catch {
        return null
    }
    const bom = text.startsWith(BOM)
    return { text: bom ? text.slice(1) : text, bom }
}

export async function realPathOf(file: string): Promise<string> {
    return realpath(file).catch(() => file)
}

/** Most files a project listing returns; a repository with more is not one an editor should read whole. */
export const MAX_PROJECT_SOURCES = 6000
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/
/** Folders a walk (outside git) never enters. */
const NOT_SOURCE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'release', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.venv', 'target', 'vendor'])

/** Source files under `root`: what git lists (tracked and untracked, not ignored), else a bounded walk. */
export async function projectSources(root: string): Promise<string[]> {
    const listed = await new Promise<string[] | null>((resolve) => {
        execFile('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? null : String(stdout).split('\0').filter(f => SOURCE.test(f)))
        })
    })
    if (listed)
        return listed.filter(f => !f.split('/').includes('node_modules')).slice(0, MAX_PROJECT_SOURCES).map(f => path.join(root, f))
    const out: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (out.length >= MAX_PROJECT_SOURCES || depth > 12)
            return
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])
        await Promise.all(dirents.map(async (d) => {
            if (d.isDirectory() && !NOT_SOURCE_DIRS.has(d.name) && !d.name.startsWith('.'))
                await walk(path.join(dir, d.name), depth + 1)
            else if (d.isFile() && SOURCE.test(d.name) && out.length < MAX_PROJECT_SOURCES)
                out.push(path.join(dir, d.name))
        }))
    }
    await walk(root, 0)
    return out.sort()
}

export async function readText(file: string): Promise<FileRead> {
    let size: number
    try {
        const info = await stat(file)
        if (info.isDirectory())
            return { kind: 'missing' }
        size = info.size
    }
    catch {
        return { kind: 'missing' }
    }
    if (size > MAX_EDIT_BYTES)
        return { kind: 'tooLarge', size }
    const bytes = await readFile(file).catch(() => null)
    if (!bytes)
        return { kind: 'missing' }
    const decoded = decodeText(bytes)
    return decoded ? { kind: 'text', size: bytes.length, ...decoded } : { kind: 'binary', size: bytes.length }
}

/**
 * Saves the editor's text. `expected` is the text the editor last saw on disk: when the file holds
 * something else now (an agent wrote it meanwhile), nothing is written and the disk version comes
 * back, so the editor can show the conflict instead of overwriting the agent's work. null skips the
 * check (the user chose to overwrite). Writes in place, so the file keeps its mode and links.
 */
export async function writeText(file: string, text: string, options: { expected: string | null, bom: boolean }): Promise<FileWrite> {
    if (options.expected !== null) {
        const disk = await readText(file)
        const current = disk.kind === 'text' ? disk.text : disk.kind === 'missing' ? null : undefined
        if (current !== options.expected)
            return { ok: false, disk }
    }
    // Creating it again after a delete is fine; writing through a folder is not.
    const handle = await open(file, 'w')
    try {
        await handle.writeFile(options.bom ? BOM + text : text, 'utf8')
    }
    finally {
        await handle.close()
    }
    return { ok: true }
}

/**
 * Folder watchers of one window: the expanded folders of its file tree and the folders of its open
 * files (a file is watched through its folder, so editors and agents that save by renaming a new
 * file over the old one are still seen). Changes come out in batches, per folder: the entry names,
 * and whether entries came or went (a "rename" event) rather than only changed content.
 */
export class FolderWatch {
    private watchers = new Map<string, FSWatcher>()
    private pending = new Map<string, DirChange>()
    private timer: ReturnType<typeof setTimeout> | null = null

    constructor(private emit: (changes: DirChange[]) => void, private delay = 80) {}

    /** Watches exactly these folders from now on. */
    set(dirs: string[]) {
        const wanted = new Set(dirs.filter(d => path.isAbsolute(d)).slice(0, 2000))
        for (const [dir, watcher] of this.watchers) {
            if (!wanted.has(dir)) {
                watcher.close()
                this.watchers.delete(dir)
            }
        }
        for (const dir of wanted) {
            if (this.watchers.has(dir))
                continue
            try {
                const watcher = watch(dir, { persistent: false }, (event, name) => this.queue(dir, name ? String(name) : '', event === 'rename'))
                // The folder went away (deleted, unmounted): its parent's watcher reports that.
                watcher.on('error', () => {
                    watcher.close()
                    if (this.watchers.get(dir) === watcher)
                        this.watchers.delete(dir)
                    this.queue(dir, '', true)
                })
                this.watchers.set(dir, watcher)
            }
            catch {
                // Missing or unreadable: nothing to watch.
            }
        }
    }

    get size(): number {
        return this.watchers.size
    }

    private queue(dir: string, name: string, listed: boolean) {
        if (HIDDEN.has(name))
            return
        let change = this.pending.get(dir)
        if (!change)
            this.pending.set(dir, change = { dir, names: [], listed: false })
        if (!change.names.includes(name))
            change.names.push(name)
        change.listed ||= listed
        this.timer ??= setTimeout(() => {
            this.timer = null
            const changes = [...this.pending.values()]
            this.pending.clear()
            this.emit(changes)
        }, this.delay)
    }

    close() {
        for (const watcher of this.watchers.values())
            watcher.close()
        this.watchers.clear()
        if (this.timer)
            clearTimeout(this.timer)
        this.timer = null
        this.pending.clear()
    }
}
