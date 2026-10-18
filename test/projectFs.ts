// The editor's view of the disk (ProjectFs) on node's fs, for tests that run the real TypeScript project code.
import type { FileRead } from '@shared/ipc'
import type { ProjectFs } from '../src/lib/tsProject'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const nodeProjectFs: ProjectFs = {
    read: async (path): Promise<FileRead> => {
        try {
            if (statSync(path).isDirectory())
                return { kind: 'missing' }
            const text = readFileSync(path, 'utf8')
            return { kind: 'text', text, bom: false, size: text.length }
        }
        catch {
            return { kind: 'missing' }
        }
    },
    realPath: async path => realpathSync(path),
    sources: async (dir) => {
        const out: string[] = []
        const walk = (d: string) => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'dist-electron' || e.name === 'release')
                    continue
                if (e.isDirectory())
                    walk(join(d, e.name))
                else if (/\.[cm]?[jt]sx?$/.test(e.name))
                    out.push(join(d, e.name))
            }
        }
        walk(dir)
        return out
    },
    folders: async (dir) => {
        try {
            return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        }
        catch {
            return []
        }
    },
}
