import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { globalCompaction, patchCompaction, readGlobalCompaction, resolveCompaction, setGlobalCompaction } from './piSettings'

describe('resolveCompaction', () => {
    it('prefers the model override, then the ordinary setting, then the default', () => {
        const settings = { compaction: { reserveTokens: 20000, modelOverrides: { 'anthropic/opus': { reserveTokens: 750000 } } } }
        expect(resolveCompaction(settings, 'anthropic/opus')).toEqual({ enabled: true, reserveTokens: 750000 })
        expect(resolveCompaction(settings, 'anthropic/haiku')).toEqual({ enabled: true, reserveTokens: 20000 })
        expect(resolveCompaction({}, 'x/y')).toEqual({ enabled: true, reserveTokens: 16384 })
    })

    it('reports disabled compaction and ignores invalid numbers', () => {
        expect(resolveCompaction({ compaction: { enabled: false, reserveTokens: -1 } })).toEqual({ enabled: false, reserveTokens: 16384 })
    })
})

describe('global compaction settings', () => {
    it('fills in pi defaults and reports overrides', () => {
        expect(readGlobalCompaction({}, {})).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, modelReserves: {}, projectOverride: false })
        expect(readGlobalCompaction(
            { compaction: { enabled: false, reserveTokens: 32768, modelOverrides: { 'a/b': { reserveTokens: 1 }, 'c/d': { keepRecentTokens: 5 }, 'e/f': 'x' } } },
            { compaction: { keepRecentTokens: 5000 } },
        )).toEqual({ enabled: false, reserveTokens: 32768, keepRecentTokens: 20000, modelReserves: { 'a/b': 1 }, projectOverride: true })
    })

    it('patches only compaction fields and drops values equal to the defaults', () => {
        const settings = { theme: 'dark', compaction: { reserveTokens: 8192, modelOverrides: { 'a/b': { reserveTokens: 1 } } } }
        expect(patchCompaction(settings, { reserveTokens: 32768, keepRecentTokens: 40000 })).toEqual({
            theme: 'dark',
            compaction: { reserveTokens: 32768, keepRecentTokens: 40000, modelOverrides: { 'a/b': { reserveTokens: 1 } } },
        })
        expect(patchCompaction({ theme: 'dark', compaction: { enabled: false } }, { enabled: true })).toEqual({ theme: 'dark' })
        expect(settings.compaction.reserveTokens).toBe(8192)
    })

    it('sets and removes one model\'s reserve, keeping its other fields and other models', () => {
        const settings = { compaction: { modelOverrides: { 'a/b': { reserveTokens: 1, keepRecentTokens: 9 }, 'c/d': { reserveTokens: 2 } } } }
        expect(patchCompaction(settings, { modelReserves: { 'x/y/z': 850000 } }).compaction.modelOverrides).toEqual({
            'a/b': { reserveTokens: 1, keepRecentTokens: 9 },
            'c/d': { reserveTokens: 2 },
            'x/y/z': { reserveTokens: 850000 },
        })
        expect(patchCompaction(settings, { modelReserves: { 'a/b': null } }).compaction.modelOverrides).toEqual({
            'a/b': { keepRecentTokens: 9 },
            'c/d': { reserveTokens: 2 },
        })
        expect(patchCompaction({ theme: 'dark', compaction: { modelOverrides: { 'c/d': { reserveTokens: 2 } } } }, { modelReserves: { 'c/d': null } })).toEqual({ theme: 'dark' })
        expect(settings.compaction.modelOverrides['a/b'].reserveTokens).toBe(1)
    })
})

describe('setGlobalCompaction', () => {
    it('writes into PI_CODING_AGENT_DIR/settings.json, keeps other keys and refuses invalid JSON', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-gui-settings-'))
        const prev = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = dir
        try {
            const file = path.join(dir, 'settings.json')
            await writeFile(file, JSON.stringify({ defaultModel: 'x', compaction: { enabled: false } }))
            await setGlobalCompaction({ enabled: true, reserveTokens: 32768, keepRecentTokens: -5 } as any)
            expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ defaultModel: 'x', compaction: { reserveTokens: 32768 } })
            expect(await globalCompaction()).toMatchObject({ enabled: true, reserveTokens: 32768, keepRecentTokens: 20000 })
            expect(existsSync(`${file}.lock`)).toBe(false)

            // A bad model key or value is dropped; the rest of the patch still applies.
            await setGlobalCompaction({ modelReserves: { '': 5, 'a/b': 850000, 'c/d': 900000, 'e/f': -1 } } as any)
            await setGlobalCompaction({ modelReserves: { 'c/d': null } })
            expect(await globalCompaction()).toMatchObject({ reserveTokens: 32768, modelReserves: { 'a/b': 850000 } })

            await writeFile(file, '{ broken')
            await expect(setGlobalCompaction({ enabled: false })).rejects.toThrow('不是有效的 JSON')
            expect(await readFile(file, 'utf8')).toBe('{ broken')
        }
        finally {
            process.env.PI_CODING_AGENT_DIR = prev
            await rm(dir, { recursive: true, force: true })
        }
    })
})
