// Channels, as cc-switch has them: Claude Code or Codex pointed at one of pi's provider models in
// its own config file, so `claude` and `codex` in a terminal use it too and it stays when the app
// quits. The app's threads add only the gateway's address, for cache warming (warm.ts): it passes
// their requests on to the channel as they came. What the keys held before is kept aside, so the
// config can go back to it.
import type { JsonEdit } from './terminalSync'
import type { MemberTarget } from './server'
import { tomlString } from './agentConfig'

export interface ChannelTarget {
    provider: string
    model: string
    providerName: string
    target: MemberTarget
}

const TIERS = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']

/**
 * ~/.claude/settings.json on a channel. The same keys every time, so the stash covers them all. A
 * model that is not a Claude one takes every tier too, or Claude Code would ask it for claude-*
 * models by name (background work, subagents).
 */
export function claudeChannelEdits(channel: ChannelTarget): JsonEdit[] {
    const headers = Object.entries(channel.target.headers ?? {})
    const other = !channel.model.startsWith('claude-')
    return [
        { path: ['env', 'ANTHROPIC_BASE_URL'], value: channel.target.baseUrl },
        { path: ['env', 'ANTHROPIC_AUTH_TOKEN'], value: channel.target.apiKey },
        { path: ['env', 'ANTHROPIC_API_KEY'], value: undefined },
        { path: ['env', 'ANTHROPIC_CUSTOM_HEADERS'], value: headers.length ? headers.map(([k, v]) => `${k}: ${v}`).join('\n') : undefined },
        // Its own /model writes `model`; an ANTHROPIC_MODEL would win over it.
        { path: ['env', 'ANTHROPIC_MODEL'], value: undefined },
        { path: ['model'], value: channel.model },
        ...TIERS.map(name => ({ path: ['env', name], value: other ? channel.model : undefined })),
    ]
}

// ---------------------------------------------------------------- Codex

/** Codex refuses tables named like its built-in providers (openai, ollama…), so the app's have a prefix. */
export const codexProviderId = (provider: string) => `pi-${provider}`

/** The top-level keys a channel sets; the lines they were before go in the stash (null: absent). */
export const CODEX_KEYS = ['model_provider', 'model'] as const
export type CodexLines = Record<typeof CODEX_KEYS[number], string | null>

const keyOf = (line: string) => {
    const t = line.trim()
    const eq = t.indexOf('=')
    return t.startsWith('#') || t.startsWith('[') || eq < 0 ? undefined : t.slice(0, eq).trim()
}

const isHeader = (line: string) => line.trim().startsWith('[')

const header = (id: string) => `[model_providers.${tomlString(id)}]`

/** The value of a TOML string (basic or literal), a trailing comment left out; undefined for other values. */
export function tomlStringValue(raw: string): string | undefined {
    const t = raw.trim()
    if (t.startsWith('\'')) {
        const end = t.indexOf('\'', 1)
        return end > 0 ? t.slice(1, end) : undefined
    }
    if (!t.startsWith('"'))
        return undefined
    for (let i = 1; i < t.length; i++) {
        if (t[i] === '\\')
            i++
        else if (t[i] === '"') {
            try {
                return JSON.parse(t.slice(0, i + 1))
            }
            catch {
                return undefined
            }
        }
    }
    return undefined
}

/** The top-level lines (before the first table) of each channel key. */
export function codexLines(text: string): CodexLines {
    const lines = text.split('\n')
    const end = lines.findIndex(isHeader)
    const top = end < 0 ? lines : lines.slice(0, end)
    const find = (key: string) => top.find(line => keyOf(line) === key) ?? null
    return { model_provider: find('model_provider'), model: find('model') }
}

/** The string a top-level line holds. */
export const lineValue = (line: string | null) => (line ? tomlStringValue(line.slice(line.indexOf('=') + 1)) : undefined)

/**
 * Codex's config.toml with the channel keys set to `lines` (null takes a key out) and a table for
 * each of `tables`, in place of the one it had. Tables stay when the keys move on: a session Codex
 * ran on a provider needs its table to resume, in a terminal too.
 */
export function codexChannelToml(text: string, lines: CodexLines, tables: ChannelTarget[] = []): string {
    let rows = text.split('\n')
    for (const channel of tables) {
        const at = rows.findIndex(line => line.trim() === header(codexProviderId(channel.provider)))
        if (at < 0)
            continue
        let end = rows.findIndex((line, i) => i > at && isHeader(line))
        if (end < 0)
            end = rows.length
        let start = at
        while (start > 0 && !rows[start - 1].trim())
            start--
        // One blank line stays between what was around it, and the file keeps its last newline.
        rows = [...rows.slice(0, start), ...(end === rows.length || start > 0 ? [''] : []), ...rows.slice(end)]
    }
    for (const key of CODEX_KEYS) {
        const end = rows.findIndex(isHeader)
        const at = rows.findIndex((line, i) => (end < 0 || i < end) && keyOf(line) === key)
        const line = lines[key]
        if (at >= 0 && line === null)
            rows.splice(at, 1)
        else if (at >= 0)
            rows[at] = line!
        else if (line !== null)
            rows.unshift(line)
    }
    let body = rows.join('\n')
    for (const channel of tables) {
        const { baseUrl, apiKey, headers } = channel.target
        const headerList = Object.entries(headers ?? {}).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
        const table = [
            header(codexProviderId(channel.provider)),
            `name = ${tomlString(channel.providerName)}`,
            `base_url = ${tomlString(baseUrl)}`,
            'wire_api = "responses"',
            ...(apiKey ? [`experimental_bearer_token = ${tomlString(apiKey)}`] : []),
            ...(headerList.length ? [`http_headers = { ${headerList.join(', ')} }`] : []),
        ].join('\n')
        while (body.endsWith('\n'))
            body = body.slice(0, -1)
        body = body.trim() ? `${body}\n\n${table}\n` : `${table}\n`
    }
    return body
}

/** The pi providers the file has a table of the app's for. */
export function codexTables(text: string): string[] {
    const prefix = `[model_providers.`
    return text.split('\n').flatMap((line) => {
        const t = line.trim()
        const id = t.startsWith(prefix) && t.endsWith(']') ? tomlStringValue(t.slice(prefix.length, -1)) : undefined
        return id?.startsWith('pi-') ? [id.slice(3)] : []
    })
}

/** The lines a channel sets at the top. */
export const codexChannelLines = (channel: ChannelTarget): CodexLines => ({
    model_provider: `model_provider = ${tomlString(codexProviderId(channel.provider))}`,
    model: `model = ${tomlString(channel.model)}`,
})
