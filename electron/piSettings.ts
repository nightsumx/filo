// Compaction settings as pi resolves them (core/settings-manager.js getCompactionSettings):
// global ~/.pi/agent/settings.json deep-merged with <cwd>/.pi/settings.json, then
// compaction.modelOverrides["provider/id"] over compaction.*, then pi's defaults.
import type { CompactionInfo, GlobalCompaction, GlobalCompactionPatch } from '@shared/ipc'
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { tr } from './i18n'

export const DEFAULT_RESERVE_TOKENS = 16384
export const DEFAULT_KEEP_RECENT_TOKENS = 20000

async function readJson(file: string): Promise<Record<string, any>> {
    try {
        const value = JSON.parse(await readFile(file, 'utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }
    catch {
        return {}
    }
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function merge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { ...a }
    for (const [k, v] of Object.entries(b))
        out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v
    return out
}

const tokenSetting = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined)

export function resolveCompaction(settings: Record<string, any>, modelKey?: string): CompactionInfo {
    const compaction = isObject(settings.compaction) ? settings.compaction : {}
    const override = modelKey && isObject(compaction.modelOverrides) && isObject(compaction.modelOverrides[modelKey])
        ? compaction.modelOverrides[modelKey]
        : {}
    return {
        enabled: compaction.enabled !== false,
        reserveTokens: tokenSetting(override.reserveTokens) ?? tokenSetting(compaction.reserveTokens) ?? DEFAULT_RESERVE_TOKENS,
    }
}

const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const globalSettingsPath = () => path.join(agentDir(), 'settings.json')

export async function compactionInfo(cwd: string, modelKey?: string): Promise<CompactionInfo> {
    const [global, project] = await Promise.all([
        readJson(globalSettingsPath()),
        path.isAbsolute(cwd) ? readJson(path.join(cwd, '.pi', 'settings.json')) : Promise.resolve({}),
    ])
    return resolveCompaction(merge(global, project), modelKey)
}

// ---------------------------------------------------------------- global compaction (Settings page)

/** The global compaction fields the Settings page edits, with pi's defaults filled in. */
export function readGlobalCompaction(global: Record<string, any>, project: Record<string, any>): GlobalCompaction {
    const c = isObject(global.compaction) ? global.compaction : {}
    const p = isObject(project.compaction) ? project.compaction : {}
    return {
        enabled: c.enabled !== false,
        reserveTokens: tokenSetting(c.reserveTokens) ?? DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: tokenSetting(c.keepRecentTokens) ?? DEFAULT_KEEP_RECENT_TOKENS,
        modelReserves: Object.fromEntries(Object.entries(isObject(c.modelOverrides) ? c.modelOverrides : {})
            .flatMap(([model, o]) => {
                const reserve = isObject(o) ? tokenSetting(o.reserveTokens) : undefined
                return reserve === undefined ? [] : [[model, reserve] as const]
            })),
        projectOverride: ['enabled', 'reserveTokens', 'keepRecentTokens'].some(k => k in p),
    }
}

/**
 * Applies a patch to the `compaction` object of a settings file. Values equal to pi's defaults are
 * removed rather than written, so the file only records real choices. Everything else is kept.
 */
export function patchCompaction(settings: Record<string, any>, patch: GlobalCompactionPatch): Record<string, any> {
    const compaction: Record<string, any> = isObject(settings.compaction) ? { ...settings.compaction } : {}
    const set = (key: string, value: unknown, fallback: unknown) => {
        if (value === undefined)
            return
        if (value === fallback)
            delete compaction[key]
        else
            compaction[key] = value
    }
    set('enabled', patch.enabled, true)
    set('reserveTokens', patch.reserveTokens, DEFAULT_RESERVE_TOKENS)
    set('keepRecentTokens', patch.keepRecentTokens, DEFAULT_KEEP_RECENT_TOKENS)
    if (patch.modelReserves && Object.keys(patch.modelReserves).length) {
        // Other fields of a model's entry (keepRecentTokens) and unlisted models stay as they are.
        const overrides: Record<string, any> = isObject(compaction.modelOverrides) ? { ...compaction.modelOverrides } : {}
        for (const [model, reserveTokens] of Object.entries(patch.modelReserves)) {
            const entry: Record<string, any> = isObject(overrides[model]) ? { ...overrides[model] } : {}
            if (reserveTokens === null)
                delete entry.reserveTokens
            else
                entry.reserveTokens = reserveTokens
            if (Object.keys(entry).length)
                overrides[model] = entry
            else
                delete overrides[model]
        }
        if (Object.keys(overrides).length)
            compaction.modelOverrides = overrides
        else
            delete compaction.modelOverrides
    }
    const next = { ...settings }
    if (Object.keys(compaction).length)
        next.compaction = compaction
    else
        delete next.compaction
    return next
}

const LOCK_STALE_MS = 10_000

/**
 * The lock pi takes around settings writes (proper-lockfile: a `<file>.lock` directory, stale after
 * 10s), so a write here never interleaves with pi's own read-merge-write.
 */
async function withSettingsLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${file}.lock`
    await mkdir(path.dirname(file), { recursive: true })
    for (let attempt = 0; ; attempt++) {
        try {
            await mkdir(lock)
            break
        }
        catch (error: any) {
            if (error?.code !== 'EEXIST' || attempt >= 100)
                throw new Error(tr('pi 的 settings.json 正被占用，稍后再试', 'pi\'s settings.json is in use; try again in a moment'))
            const age = await stat(lock).then(s => Date.now() - s.mtimeMs, () => 0)
            if (age > LOCK_STALE_MS)
                await rmdir(lock).catch(() => {})
            else
                await new Promise(r => setTimeout(r, 20))
        }
    }
    try {
        return await fn()
    }
    finally {
        await rmdir(lock).catch(() => {})
    }
}

const TOKEN_LIMIT = 10_000_000

function validPatch(patch: unknown): GlobalCompactionPatch {
    const p = isObject(patch) ? patch : {}
    const tokens = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= TOKEN_LIMIT ? v : undefined)
    const modelReserves: Record<string, number | null> = {}
    for (const [model, value] of Object.entries(isObject(p.modelReserves) ? p.modelReserves : {}).slice(0, 1000)) {
        const reserve = value === null ? null : tokens(value)
        if (model.length > 0 && model.length <= 200 && reserve !== undefined)
            modelReserves[model] = reserve
    }
    return {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
        reserveTokens: tokens(p.reserveTokens),
        keepRecentTokens: tokens(p.keepRecentTokens),
        modelReserves,
    }
}

export async function globalCompaction(cwd?: string): Promise<GlobalCompaction> {
    const [global, project] = await Promise.all([
        readJson(globalSettingsPath()),
        cwd && path.isAbsolute(cwd) ? readJson(path.join(cwd, '.pi', 'settings.json')) : Promise.resolve({}),
    ])
    return readGlobalCompaction(global, project)
}

/** Writes the patch into ~/.pi/agent/settings.json, leaving every other setting untouched. */
export async function setGlobalCompaction(patch: unknown): Promise<void> {
    const file = globalSettingsPath()
    const valid = validPatch(patch)
    await withSettingsLock(file, async () => {
        let current: Record<string, any> = {}
        const text = await readFile(file, 'utf8').catch((error: any) => {
            if (error?.code === 'ENOENT')
                return ''
            throw error
        })
        if (text.trim()) {
            try {
                current = JSON.parse(text.replace(/^\uFEFF/, ''))
            }
            catch {
                throw new Error(tr('settings.json 不是有效的 JSON，没有修改', 'settings.json is not valid JSON; nothing was changed'))
            }
            if (!isObject(current))
                throw new Error(tr('settings.json 不是一个对象，没有修改', 'settings.json is not an object; nothing was changed'))
        }
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, `${JSON.stringify(patchCompaction(current, valid), null, 2)}\n`, 'utf8')
        await rename(tmp, file)
    })
}
