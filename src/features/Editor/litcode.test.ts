import type { ProjectLink } from '@/store/codeIntel'
import { describe, expect, it, vi } from 'vitest'
import { lazyLink } from './litcode'

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
