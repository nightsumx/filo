// pi's settings.json as the app reads and writes it. Compaction as pi resolves it
// (core/settings-manager.js getCompactionSettings): global ~/.pi/agent/settings.json deep-merged with
// <cwd>/.pi/settings.json when pi trusts the project, then compaction.modelOverrides["provider/id"] over compaction.*, then pi's
// defaults. The capability choice (SETTINGS_KEY), shared with pi-cc-tui. And a watch on the file, which
// pi in a terminal writes too.
import type { CapabilityState } from '@shared/capabilities'
import type { CompactionInfo, GlobalCompaction, GlobalCompactionPatch, PiDefaults, PiSettingsState } from '@shared/ipc'
import { CACHE_WARMING } from '@shared/ipc'
import { THINKING_LEVELS } from '@shared/pi'
import type { FSWatcher } from 'node:fs'
import { capabilityChoice, capabilityState } from '@shared/capabilities'
import { watch } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { SettingsWriteError, updateSettings, writeCapabilityChoice } from 'pi-capabilities/lib/settings.ts'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { tr } from './i18n'
import { packageState, withPackageEnabled } from './piPackages'

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

export const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const globalSettingsPath = () => path.join(agentDir(), 'settings.json')

/**
 * The global settings and <cwd>/.pi/settings.json as pi outside its TUI applies them (main.js
 * createRuntime, core/project-trust.js): the project's only when trust.json trusts it, the nearest
 * folder's decision winning, or with no decision when defaultProjectTrust is "always". Only the TUI
 * asks; an untrusted project's settings are ignored by the pi a thread runs.
 */
async function settingsFor(cwd: unknown): Promise<{ global: Record<string, any>, project: Record<string, any> }> {
    const global = await readJson(globalSettingsPath())
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd))
        return { global, project: {} }
    const [project, trust] = await Promise.all([readJson(path.join(cwd, '.pi', 'settings.json')), readJson(path.join(agentDir(), 'trust.json'))])
    for (let dir = await realpath(cwd).catch(() => cwd); ; dir = path.dirname(dir)) {
        if (typeof trust[dir] === 'boolean')
            return { global, project: trust[dir] ? project : {} }
        if (path.dirname(dir) === dir)
            return { global, project: global.defaultProjectTrust === 'always' ? project : {} }
    }
}

export async function compactionInfo(cwd: string, modelKey?: string): Promise<CompactionInfo> {
    const { global, project } = await settingsFor(cwd)
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
    const { global, project } = await settingsFor(cwd)
    return readGlobalCompaction(global, project)
}

/** Writes the patch into ~/.pi/agent/settings.json, leaving every other setting untouched. */
export async function setGlobalCompaction(patch: unknown): Promise<void> {
    const valid = validPatch(patch)
    await updateGlobalSettings(current => patchCompaction(current, valid))
}

/** updateSettings on ~/.pi/agent/settings.json, its refusals in the app's words. */
async function updateGlobalSettings(change: (current: Record<string, any>) => Record<string, any>): Promise<void> {
    await updateSettings(globalSettingsPath(), change).catch(rephrase)
}

function rephrase(error: unknown): never {
    if (!(error instanceof SettingsWriteError))
        throw error
    throw new Error({
        'busy': tr('pi 的 settings.json 正被占用，稍后再试', 'pi\'s settings.json is in use; try again in a moment'),
        'invalid-json': tr('settings.json 不是有效的 JSON，没有修改', 'settings.json is not valid JSON; nothing was changed'),
        'not-object': tr('settings.json 不是一个对象，没有修改', 'settings.json is not an object; nothing was changed'),
    }[error.reason])
}

// ---------------------------------------------------------------- capabilities (Settings page, composer)

/** Which capabilities load and the approval mode new sessions start in, shared with pi-cc-tui. */
export async function readCapabilities(): Promise<CapabilityState> {
    return capabilityState(capabilityChoice(await readJson(globalSettingsPath())))
}

/** Merges the patch into settings.json's SETTINGS_KEY; fields it leaves out keep their value. */
export async function setCapabilities(patch: unknown): Promise<void> {
    await writeCapabilityChoice(agentDir(), patch).catch(rephrase)
}

/** Web access (piPackages.ts) on or off; pi loads the change at its next start. */
export async function setWebAccess(enabled: boolean): Promise<void> {
    await updateGlobalSettings(current => withPackageEnabled(current, enabled === true))
}

/** pi's own `cacheWarming`, the setting its /settings changes in a terminal. */
export async function setCacheWarming(mode: unknown): Promise<void> {
    const valid = CACHE_WARMING.find(m => m === mode)
    if (!valid)
        throw new Error(`Unknown cache warming mode: ${String(mode)}`)
    await updateGlobalSettings(current => ({ ...current, cacheWarming: valid }))
}

async function mergedSettings(cwd: unknown): Promise<Record<string, any>> {
    const { global, project } = await settingsFor(cwd)
    return merge(global, project)
}

export async function piDefaults(cwd: unknown): Promise<PiDefaults> {
    const settings = await mergedSettings(cwd)
    return {
        model: typeof settings.defaultProvider === 'string' && typeof settings.defaultModel === 'string' ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined,
        thinkingLevel: THINKING_LEVELS.find(l => l === settings.defaultThinkingLevel) ?? 'medium',
    }
}

/**
 * What pi's TUI writes when a model is set as the default (agent-session.js setModel with persist):
 * new sessions, here and in a terminal, start on it. With enabledModels set, the model joins it, so
 * it stays among the scoped ones; a glob that already covers it gets the exact name next to it.
 */
export async function setDefaultModel(cwd: unknown, provider: unknown, model: unknown): Promise<void> {
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model)
        throw new Error(`Invalid model: ${String(provider)}/${String(model)}`)
    const ref = `${provider}/${model}`
    const enabled = (await mergedSettings(cwd)).enabledModels
    const patterns: string[] = Array.isArray(enabled) ? enabled.filter(p => typeof p === 'string') : []
    const listed = patterns.some(p => p.toLowerCase() === ref.toLowerCase() || p.toLowerCase() === model.toLowerCase())
    await updateGlobalSettings(current => ({
        ...current,
        defaultProvider: provider,
        defaultModel: model,
        ...(patterns.length && !listed ? { enabledModels: [...patterns, ref] } : {}),
    }))
}

/** pi's enabledModels as the merged settings have it: the patterns, or null when every model is in. */
export async function enabledModels(cwd: unknown): Promise<string[] | null> {
    const list = (await mergedSettings(cwd)).enabledModels
    return Array.isArray(list) && list.length ? list.filter((p): p is string => typeof p === 'string') : null
}

/** /scoped-models, saved: pi's TUI writes enabledModels, and removes the key for "all models". */
export async function setEnabledModels(patterns: unknown): Promise<void> {
    if (patterns !== null && !(Array.isArray(patterns) && patterns.every(p => typeof p === 'string' && p)))
        throw new Error('expected model patterns or null')
    await updateGlobalSettings((current) => {
        const { enabledModels: _old, ...rest } = current
        return patterns === null || !patterns.length ? rest : { ...rest, enabledModels: patterns }
    })
}

/** pi's TUI thinking selector, "set as default". */
export async function setDefaultThinkingLevel(level: unknown): Promise<void> {
    const valid = THINKING_LEVELS.find(l => l === level)
    if (!valid)
        throw new Error(`Unknown thinking level: ${String(level)}`)
    await updateGlobalSettings(current => ({ ...current, defaultThinkingLevel: valid }))
}

// ---------------------------------------------------------------- watching (the terminal changes it too)

/**
 * What in settings.json a running pi read at startup and keeps using: the resources it loaded,
 * compaction and cache warming. pi writes other keys as it runs (the last model, the changelog it
 * showed), which need no restart. Per-model compaction is apart (only threads on that model restart), and the capability
 * choice too (threads compare the capabilities themselves).
 */
const STARTUP_KEYS = ['packages', 'extensions', 'skills', 'prompts', 'themes', 'compaction', 'cacheWarming']

export function piSettingsOf(settings: Record<string, any>): PiSettingsState {
    const { modelOverrides, ...compaction } = isObject(settings.compaction) ? settings.compaction : {} as Record<string, any>
    const startup = STARTUP_KEYS.map(key => key === 'compaction' ? compaction : settings[key] ?? null)
    return {
        fingerprint: JSON.stringify(startup),
        modelOverrides: isObject(modelOverrides) ? modelOverrides : {},
        capabilities: capabilityState(capabilityChoice(settings)),
        webAccess: packageState(settings),
        cacheWarming: CACHE_WARMING.includes(settings.cacheWarming) ? settings.cacheWarming : 'streaming',
    }
}

export async function piSettingsState(): Promise<PiSettingsState> {
    return piSettingsOf(await readJson(globalSettingsPath()))
}

/**
 * Calls `changed` whenever settings.json changes what pi processes use or the capability choice,
 * whoever wrote it (this app, pi in a terminal, an editor). Returns the stop function.
 */
export function watchSettings(changed: (state: PiSettingsState) => void): () => void {
    let last: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
        timer = undefined
        void piSettingsState().then((state) => {
            const key = JSON.stringify(state)
            if (last !== undefined && key !== last)
                changed(state)
            last = key
        })
    }
    check()
    let watcher: FSWatcher | undefined
    try {
        // The folder, not the file: pi and this app replace the file by renaming over it.
        watcher = watch(agentDir(), (_event, name) => {
            if (name === 'settings.json' && !timer)
                timer = setTimeout(check, 150)
        })
        watcher.on('error', () => {})
    }
    catch {}
    return () => {
        watcher?.close()
        if (timer)
            clearTimeout(timer)
    }
}
