import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { globalCompaction, patchCompaction, piDefaults, piSettingsOf, piSettingsState, readCapabilities, readGlobalCompaction, resolveCompaction, setCapabilities, setDefaultModel, setDefaultThinkingLevel, setGlobalCompaction, watchSettings } from './piSettings'

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

/** Runs `body` with PI_CODING_AGENT_DIR pointing at a fresh folder. */
async function inAgentDir(body: (dir: string, file: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-gui-settings-'))
    const prev = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    try {
        await body(dir, path.join(dir, 'settings.json'))
    }
    finally {
        process.env.PI_CODING_AGENT_DIR = prev
        await rm(dir, { recursive: true, force: true })
    }
}

const FULL = ['todo', 'ask', 'approval', 'plan', 'subagent', 'review', 'autopilot', 'budget', 'terminal', 'browser']

describe('new-session defaults', () => {
    it('reads them as pi merges them for a project it trusts, and writes them as its TUI saves them', () => inAgentDir(async (dir, file) => {
        const project = path.join(dir, 'project')
        expect(await piDefaults(project)).toEqual({ model: undefined, thinkingLevel: 'medium' })

        await writeFile(file, JSON.stringify({ theme: 'dark', defaultProvider: 'a', defaultModel: 'one', enabledModels: ['a/one', 'b/*'] }))
        await mkdir(path.join(project, '.pi'), { recursive: true })
        await writeFile(path.join(project, '.pi', 'settings.json'), JSON.stringify({ defaultModel: 'two', defaultThinkingLevel: 'high' }))
        expect(await piDefaults(project)).toEqual({ model: 'a/one', thinkingLevel: 'medium' })
        const real = await realpath(project)
        const trust = path.join(dir, 'trust.json')
        await writeFile(trust, JSON.stringify({ [path.dirname(real)]: true }))
        expect(await piDefaults(project)).toEqual({ model: 'a/two', thinkingLevel: 'high' })
        await writeFile(trust, JSON.stringify({ [path.dirname(real)]: true, [real]: false }))
        expect((await piDefaults(project)).model).toBe('a/one')
        await writeFile(trust, '{}')
        await writeFile(file, JSON.stringify({ theme: 'dark', defaultProvider: 'a', defaultModel: 'one', enabledModels: ['a/one', 'b/*'], defaultProjectTrust: 'always' }))
        expect(await piDefaults(project)).toEqual({ model: 'a/two', thinkingLevel: 'high' })
        await writeFile(file, JSON.stringify({ theme: 'dark', defaultProvider: 'a', defaultModel: 'one', enabledModels: ['a/one', 'b/*'] }))
        expect(await piDefaults('relative')).toEqual({ model: 'a/one', thinkingLevel: 'medium' })

        // A model the scope does not name joins it; one it names leaves it as it is.
        await setDefaultModel(project, 'c', 'three')
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ theme: 'dark', defaultProvider: 'c', defaultModel: 'three', enabledModels: ['a/one', 'b/*', 'c/three'] })
        await setDefaultModel(project, 'A', 'ONE')
        expect(JSON.parse(await readFile(file, 'utf8')).enabledModels).toEqual(['a/one', 'b/*', 'c/three'])

        await setDefaultThinkingLevel('low')
        expect(JSON.parse(await readFile(file, 'utf8')).defaultThinkingLevel).toBe('low')
        await expect(setDefaultThinkingLevel('huge')).rejects.toThrow()
        await expect(setDefaultModel(project, '', 'x')).rejects.toThrow()
    }))
})

describe('capability settings', () => {
    it('nothing saved (no file, no key, a broken key) is the full preset in auto mode', async () => {
        await inAgentDir(async (_dir, file) => {
            expect(await readCapabilities()).toEqual({ ids: FULL, preset: 'full', approvalMode: 'auto', budget: 5, saved: false })
            await writeFile(file, JSON.stringify({ 'pi-capabilities': ['todo'] }))
            expect((await readCapabilities()).saved).toBe(false)
        })
    })

    it('merges into its own key, keeping pi\'s settings and the field it leaves out', async () => {
        await inAgentDir(async (_dir, file) => {
            await writeFile(file, JSON.stringify({ defaultModel: 'x', packages: ['npm:a'] }))
            await setCapabilities({ enabled: 'standard' })
            await setCapabilities({ approvalMode: 'edits' })
            expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'defaultModel': 'x', 'packages': ['npm:a'], 'pi-capabilities': { enabled: 'standard', approvalMode: 'edits' } })
            expect(await readCapabilities()).toMatchObject({ preset: 'standard', approvalMode: 'edits', saved: true })

            // Lists are cleaned; unknown presets and modes are not written.
            await setCapabilities({ enabled: ['plan', 'bogus', 'todo', 'plan'] })
            await setCapabilities({ enabled: 'gone', approvalMode: 'yolo', budget: -1 })
            expect(JSON.parse(await readFile(file, 'utf8'))['pi-capabilities']).toEqual({ enabled: ['todo', 'plan'], approvalMode: 'edits' })
            expect(await readCapabilities()).toEqual({ ids: ['todo', 'plan'], approvalMode: 'edits', budget: 5, saved: true })
            await setCapabilities({ budget: 2.5 })
            expect(await readCapabilities()).toMatchObject({ ids: ['todo', 'plan'], budget: 2.5 })

            // A preset with one switched off stays off, not the preset again.
            await setCapabilities({ enabled: FULL.filter(id => id !== 'budget') })
            expect(await readCapabilities()).toMatchObject({ ids: FULL.filter(id => id !== 'budget'), preset: undefined })
        })
    })
})

describe('watching settings.json', () => {
    it('the fingerprint follows what pi reads at startup, not what it writes as it runs', () => {
        const base = { defaultModel: 'a/b', packages: ['npm:x'], compaction: { reserveTokens: 1, modelOverrides: { 'a/b': { reserveTokens: 2 } } } }
        const { fingerprint, modelOverrides } = piSettingsOf(base)
        expect(modelOverrides).toEqual({ 'a/b': { reserveTokens: 2 } })
        expect(piSettingsOf({ ...base, defaultModel: 'c/d', lastChangelogVersion: '9' }).fingerprint).toBe(fingerprint)
        expect(piSettingsOf({ ...base, compaction: { ...base.compaction, modelOverrides: {} } }).fingerprint).toBe(fingerprint)
        expect(piSettingsOf({ ...base, 'pi-capabilities': { enabled: 'lean' } }).fingerprint).toBe(fingerprint)
        expect(piSettingsOf({ ...base, packages: [] }).fingerprint).not.toBe(fingerprint)
        expect(piSettingsOf({ ...base, compaction: { reserveTokens: 3 } }).fingerprint).not.toBe(fingerprint)
    })

    it('reports a change made by anyone, once per change that matters', async () => {
        await inAgentDir(async (_dir, file) => {
            await writeFile(file, JSON.stringify({ defaultModel: 'a/b' }))
            const seen: any[] = []
            const stop = watchSettings(state => seen.push(state))
            const settle = () => new Promise(resolve => setTimeout(resolve, 400))
            try {
                await settle()
                // pi in a terminal saving the model it last used: nothing to report.
                await writeFile(file, JSON.stringify({ defaultModel: 'c/d' }))
                await settle()
                expect(seen).toEqual([])
                // pi-cc-tui's /capabilities, written the way pi writes (temp file, then rename).
                await writeFile(`${file}.tmp`, JSON.stringify({ 'defaultModel': 'c/d', 'pi-capabilities': { enabled: 'lean' } }))
                const { rename } = await import('node:fs/promises')
                await rename(`${file}.tmp`, file)
                await settle()
                expect(seen.map(s => s.capabilities.preset)).toEqual(['lean'])
                expect(seen[0]).toEqual(await piSettingsState())
            }
            finally {
                stop()
            }
        })
    })
})
