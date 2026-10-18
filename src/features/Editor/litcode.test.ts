import type { ProjectLink } from '@/store/codeIntel'
import type { FileTab } from '@/store/fileTab'
import { describe, expect, it, vi } from 'vitest'
import { codeIntel } from '@/store/codeIntel'
import { languageOf, lazyLink, prepare } from './litcode'

function link() {
    const real: ProjectLink & { synced: string[], released: number } = {
        synced: [],
        released: 0,
        sync: async (text) => {
            real.synced.push(text)
        },
        release: () => {
            real.released++
        },
    }
    return real
}

describe('lazyLink', () => {
    it('sync before the real link is there waits for it', async () => {
        const real = link()
        let arrive!: (l: ProjectLink) => void
        const lazy = lazyLink(new Promise<ProjectLink | null>((resolve) => { arrive = resolve }))
        const synced = lazy.sync('a')
        arrive(real)
        await synced
        expect(real.synced).toEqual(['a'])
    })

    it('goes straight to the real link after it arrived', async () => {
        const real = link()
        const lazy = lazyLink(Promise.resolve(real))
        await lazy.sync('a')
        await lazy.sync('b')
        lazy.release()
        expect(real.synced).toEqual(['a', 'b'])
        expect(real.released).toBe(1)
    })

    it('released before it arrived: the real one is let go as soon as it comes', async () => {
        const real = link()
        let arrive!: (l: ProjectLink) => void
        const lazy = lazyLink(new Promise<ProjectLink | null>((resolve) => { arrive = resolve }))
        lazy.release()
        expect(real.released).toBe(0)
        arrive(real)
        await vi.waitFor(() => expect(real.released).toBe(1))
    })

    it('a project that could not be read leaves it doing nothing', async () => {
        const lazy = lazyLink(Promise.resolve(null))
        await expect(lazy.sync('a')).resolves.toBeUndefined()
        expect(() => lazy.release()).not.toThrow()
    })
})

describe('prepare', () => {
    const tabOf = (name: string) => ({ name, path: `/p/${name}`, cwd: '/p', base: 'export const a = 1\n', state: null }) as unknown as FileTab

    it('light level gives the language and no project, and never asks codeIntel', async () => {
        const attach = vi.spyOn(codeIntel, 'attach')
        const kit = await prepare(tabOf('a.ts'), 'light')
        expect(kit).toMatchObject({ lang: 'typescript', level: 'light', project: null })
        expect(attach).not.toHaveBeenCalled()
        attach.mockRestore()
    })

    it('standard and full attach a project for the TypeScript family', async () => {
        const released = vi.fn()
        const attach = vi.spyOn(codeIntel, 'attach').mockResolvedValue({ sync: async () => {}, release: released })
        for (const [name, lang] of [['a.ts', 'typescript'], ['a.tsx', 'tsx'], ['a.js', 'javascript'], ['a.jsx', 'jsx']] as const) {
            for (const level of ['standard', 'full'] as const) {
                const kit = await prepare(tabOf(name), level)
                expect(kit.lang).toBe(lang)
                expect(kit.project).not.toBeNull()
                expect(attach).toHaveBeenLastCalledWith(expect.objectContaining({ name }), lang, level, 'export const a = 1\n')
            }
        }
        attach.mockRestore()
    })

    it('other languages get no project at any level', async () => {
        const attach = vi.spyOn(codeIntel, 'attach')
        for (const name of ['a.py', 'a.json', 'a.md', 'a.css']) {
            expect((await prepare(tabOf(name), 'full')).project).toBeNull()
        }
        expect(attach).not.toHaveBeenCalled()
        attach.mockRestore()
    })

    it('a file Shiki has no language for is plain text', async () => {
        const kit = await prepare(tabOf('notes.unknownext'), 'standard')
        expect(kit).toMatchObject({ lang: 'text', project: null })
    })

    it('a project that fails to attach leaves a link that does nothing', async () => {
        const attach = vi.spyOn(codeIntel, 'attach').mockRejectedValue(new Error('boom'))
        const kit = await prepare(tabOf('a.ts'), 'standard')
        await expect(kit.project?.sync('x')).resolves.toBeUndefined()
        attach.mockRestore()
    })

    it('does not wait long for a slow project', async () => {
        const attach = vi.spyOn(codeIntel, 'attach').mockReturnValue(new Promise(() => {}))
        const start = Date.now()
        await prepare(tabOf('a.ts'), 'standard')
        expect(Date.now() - start).toBeLessThan(2000)
        attach.mockRestore()
    })
})

describe('languageOf', () => {
    it('knows names, extensions and aliases', () => {
        expect(languageOf('Dockerfile')?.id).toBe('docker')
        expect(languageOf('tsconfig.json')?.id).toBe('jsonc')
        expect(languageOf('.env.local')?.id).toBe('dotenv')
        expect(languageOf('a.yml')?.id).toBe('yaml')
        expect(languageOf('A.TS')?.id).toBe('typescript')
        expect(languageOf('README')).toBeNull()
        expect(languageOf('.hidden')).toBeNull()
    })
})
