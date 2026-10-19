// What the language services need of the disk (path completion, linked stylesheets), behind one small seam:
// the app's IPC in the window, a node version in tests.
import type { FileSystemProvider } from 'vscode-css-languageservice'
import { FileType } from 'vscode-css-languageservice'

export interface WebFs {
    /** The file's text; null when it is not there or not text. */
    read: (path: string) => Promise<string | null>
    /** Names in a folder; null when it is not a folder. */
    list: (dir: string) => Promise<{ name: string, dir: boolean }[] | null>
}

export const appFs: WebFs = {
    read: async (path) => {
        const r = await window.pi.readFile(path).catch(() => null)
        return r?.kind === 'text' ? r.text : null
    },
    list: async (dir) => {
        const r = await window.pi.listDir(dir).catch(() => null)
        return r ? r.entries.map(e => ({ name: e.name, dir: e.dir })) : null
    },
}

let current: WebFs = appFs
export const webFs = (): WebFs => current
export function useWebFs(fs: WebFs) {
    current = fs
}

export const slashed = (p: string) => p.replace(/\\/g, '/')

/** `/a b/c.css` → `file:///a%20b/c.css` (and `C:/x` → `file:///C:/x`). */
export function toUri(path: string): string {
    const p = slashed(path)
    return `file://${p.startsWith('/') ? '' : '/'}${p.split('/').map(encodeURIComponent).join('/').replace(/^%2F/, '/')}`.replace(/^file:\/\/\/%3A/, 'file:///')
        .replace(/^(file:\/\/\/[A-Za-z])%3A/, '$1:')
}

export function fromUri(uri: string): string {
    if (!uri.startsWith('file://'))
        return uri
    const p = decodeURIComponent(uri.slice('file://'.length))
    return /^\/[A-Z]:\//i.test(p) ? p.slice(1) : p
}

export const dirname = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0)) || '/'

/** `ref` as seen from the file `from`, normalised: `./x`, `../y`, `/abs`; null for URLs. */
export function resolveRef(from: string, ref: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[A-Z]:[\\/]/i.test(ref))
        return null
    const clean = ref.replace(/[?#].*$/, '')
    if (!clean)
        return null
    const parts = (clean.startsWith('/') ? clean : `${dirname(slashed(from))}/${clean}`).split('/')
    const out: string[] = []
    for (const part of parts) {
        if (part === '..')
            out.pop()
        else if (part && part !== '.')
            out.push(part)
    }
    const head = /^[A-Z]:$/i.test(out[0] ?? '') ? '' : '/'
    return head + out.join('/')
}

export function provider(): FileSystemProvider {
    return {
        stat: async (uri) => {
            const path = fromUri(uri)
            const listing = await webFs().list(path)
            if (listing)
                return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 }
            const parent = await webFs().list(dirname(path))
            const hit = parent?.find(e => e.name === path.slice(path.lastIndexOf('/') + 1))
            return hit ? { type: FileType.File, ctime: 0, mtime: 0, size: 0 } : { type: FileType.Unknown, ctime: -1, mtime: -1, size: -1 }
        },
        readDirectory: async (uri) => {
            const list = await webFs().list(fromUri(uri))
            return (list ?? []).map(e => [e.name, e.dir ? FileType.Directory : FileType.File] as [string, FileType])
        },
    }
}
