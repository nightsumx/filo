// Compaction settings as pi resolves them (core/settings-manager.js getCompactionSettings):
// global ~/.pi/agent/settings.json deep-merged with <cwd>/.pi/settings.json, then
// compaction.modelOverrides["provider/id"] over compaction.*, then pi's defaults.
import type { CompactionInfo } from '@shared/ipc'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_RESERVE_TOKENS = 16384

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

export async function compactionInfo(cwd: string, modelKey?: string): Promise<CompactionInfo> {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
    const [global, project] = await Promise.all([
        readJson(path.join(agentDir, 'settings.json')),
        path.isAbsolute(cwd) ? readJson(path.join(cwd, '.pi', 'settings.json')) : Promise.resolve({}),
    ])
    return resolveCompaction(merge(global, project), modelKey)
}
