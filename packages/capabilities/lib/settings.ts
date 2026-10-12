// pi's <agent dir>/settings.json as both hosts read and write it: the capability choice
// (catalog.ts SETTINGS_KEY) and the locked read-change-write the desktop app uses for its other
// settings too. pi-cc-tui reads at extension load, so reading is synchronous.
import type { CapabilityChoice, CapabilityState } from './catalog'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { capabilityChoice, capabilityState, isBudget, normalizeCapabilities, PRESETS, SETTINGS_KEY } from './catalog'
import { APPROVAL_MODES } from '../protocol'

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A missing or broken file is no choice: the defaults. */
export function readCapabilityState(agentDir: string): CapabilityState {
    let settings: unknown
    try {
        settings = JSON.parse(readFileSync(path.join(agentDir, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''))
    }
    catch {}
    return capabilityState(capabilityChoice(settings))
}

/** Why a write did not happen; the host words it. */
export class SettingsWriteError extends Error {
    constructor(readonly reason: 'busy' | 'invalid-json' | 'not-object') {
        super(`settings.json not written: ${reason}`)
    }
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
                throw new SettingsWriteError('busy')
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

/**
 * Read-change-write of a settings.json under pi's lock, replacing the file by rename. A file that is
 * not a JSON object is left alone; every key `change` does not touch is kept as it was.
 */
export async function updateSettings(file: string, change: (current: Record<string, any>) => Record<string, any>): Promise<void> {
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
                throw new SettingsWriteError('invalid-json')
            }
            if (!isObject(current))
                throw new SettingsWriteError('not-object')
        }
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, `${JSON.stringify(change(current), null, 2)}\n`, 'utf8')
        await rename(tmp, file)
    })
}

/** Merges the patch into SETTINGS_KEY; fields it leaves out, or gets wrong, keep their value. */
export async function writeCapabilityChoice(agentDir: string, patch: unknown): Promise<void> {
    const p = isObject(patch) ? patch : {}
    const next: CapabilityChoice = {}
    if (typeof p.enabled === 'string' && PRESETS.some(preset => preset.id === p.enabled))
        next.enabled = p.enabled
    else if (Array.isArray(p.enabled))
        next.enabled = normalizeCapabilities(p.enabled)
    if (APPROVAL_MODES.includes(p.approvalMode))
        next.approvalMode = p.approvalMode
    if (isBudget(p.budget))
        next.budget = p.budget
    if (!Object.keys(next).length)
        return
    await updateSettings(path.join(agentDir, 'settings.json'), current => ({
        ...current,
        [SETTINGS_KEY]: { ...(isObject(current[SETTINGS_KEY]) ? current[SETTINGS_KEY] : {}), ...next },
    }))
}
