// Terminal sync: while the app runs, agents started from a terminal reach their models through its
// gateway too. Each edit is small and undoable: JSON files get single keys set, with what was there
// before kept aside (restored only where the value is still ours, so later edits by the user or the
// agent stay); Codex's config.toml gets a marked block at the top, and its own model_provider line
// commented out under a marker.
import type { RouteGroup } from '@shared/routes'
import { BLOCK_END, BLOCK_START, tomlString, withBlock } from './agentConfig'

// ---------------------------------------------------------------- JSON keys

export interface JsonEdit {
    path: string[]
    /** Undefined takes the key out. */
    value: unknown
}

/** One key the app set: what it held before (undefined: absent) and what the app wrote. */
export interface JsonStashEntry {
    path: string[]
    before?: unknown
    after?: unknown
    /** How many of the path's parent objects the app created (taken out again when left empty). */
    created?: number
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function parse(text: string): Json {
    if (!text.trim())
        return {}
    const value = JSON.parse(text)
    if (!isObject(value))
        throw new Error('not a JSON object')
    return value
}

function format(value: Json, original: string): string {
    const indent = /\n(\t| +)"/.exec(original)?.[1] ?? '  '
    // The file's own ending: a newline unless it had none.
    const end = !original.trim() || /\n\s*$/.test(original) ? '\n' : ''
    return `${JSON.stringify(value, null, indent)}${end}`
}

function get(root: Json, path: string[]): unknown {
    let node: unknown = root
    for (const key of path) {
        if (!isObject(node))
            return undefined
        node = node[key]
    }
    return node
}

/** Sets (or with undefined, removes) a key; returns how many parent objects it had to create. */
function put(root: Json, path: string[], value: unknown): number {
    let node = root
    let created = 0
    for (const key of path.slice(0, -1)) {
        if (!isObject(node[key])) {
            if (value === undefined)
                return 0
            node[key] = {}
            created++
        }
        node = node[key] as Json
    }
    const last = path.at(-1)!
    if (value === undefined)
        delete node[last]
    else
        node[last] = value
    return created
}

/**
 * `text` with the edits made. A key the app set before (in `stash`) and nobody changed since keeps
 * its first `before`, so applying again (a new port) still restores what the user had.
 */
export function applyJson(text: string, edits: JsonEdit[], stash: JsonStashEntry[] = []): { text: string, stash: JsonStashEntry[] } {
    const root = parse(text)
    const next: JsonStashEntry[] = []
    for (const edit of edits) {
        const current = get(root, edit.path)
        const prior = stash.find(e => same(e.path, edit.path))
        const ours = prior && same(current, prior.after)
        const created = put(root, edit.path, edit.value)
        next.push({
            path: edit.path,
            before: ours ? prior.before : current,
            after: edit.value,
            created: ours ? prior.created : created || undefined,
        })
    }
    return { text: format(root, text), stash: next }
}

/** `text` with the app's keys back as they were, where they still hold what the app wrote. */
export function restoreJson(text: string, stash: JsonStashEntry[]): string {
    const root = parse(text)
    const restored: JsonStashEntry[] = []
    for (const entry of stash) {
        if (!same(get(root, entry.path), entry.after))
            continue
        put(root, entry.path, entry.before)
        restored.push(entry)
    }
    // Parents the app made for its keys go again when nothing else is in them (after every key is back).
    for (const entry of restored) {
        for (let depth = 1; depth <= (entry.created ?? 0); depth++) {
            const parent = entry.path.slice(0, -depth)
            const node = get(root, parent)
            if (isObject(node) && !Object.keys(node).length)
                put(root, parent, undefined)
        }
    }
    return restored.length ? format(root, text) : text
}

// ---------------------------------------------------------------- Claude Code

/** ~/.claude/settings.json `env`: the gateway as its endpoint; a key of its own would win, so it goes. */
export function claudeEdits(origin: string, token: string): JsonEdit[] {
    return [
        { path: ['env', 'ANTHROPIC_BASE_URL'], value: origin },
        // A bearer token: Claude Code asks before using an ANTHROPIC_API_KEY it finds, not this.
        { path: ['env', 'ANTHROPIC_AUTH_TOKEN'], value: token },
        { path: ['env', 'ANTHROPIC_API_KEY'], value: undefined },
    ]
}

// ---------------------------------------------------------------- pi

export interface PiGroupModel {
    group: RouteGroup
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    images: boolean
}

/** pi's clients add the API's path to these (as the routes extension does). */
export function piBaseUrl(origin: string, api: RouteGroup['api']) {
    if (api === 'anthropic-messages')
        return origin
    if (api === 'google-generative-ai')
        return `${origin}/v1beta`
    return `${origin}/v1`
}

/** models.json `providers.filo`: every group as a model, with the terminal's key. */
export function piEdits(origin: string, token: string, groups: PiGroupModel[]): JsonEdit[] {
    return [{
        path: ['providers', 'filo'],
        value: {
            name: 'Filo',
            baseUrl: `${origin}/v1`,
            apiKey: token,
            api: groups[0]?.group.api ?? 'openai-completions',
            models: groups.map(g => ({
                id: g.group.id,
                name: `Filo · ${g.group.name}`,
                api: g.group.api,
                baseUrl: piBaseUrl(origin, g.group.api),
                reasoning: g.reasoning,
                input: g.images ? ['text', 'image'] : ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: g.contextWindow,
                maxTokens: g.maxTokens,
            })),
        },
    }]
}

// ---------------------------------------------------------------- Codex

/** Marks the user's own top-level model_provider while the app's block stands in for it. */
export const CODEX_SET_ASIDE = '# filo routing set aside: '

/**
 * Codex's config.toml routed through the gateway (or with `origin` undefined, back as it was). The
 * provider is a dotted key at the top, before any table, so it stays a top-level setting wherever
 * the user's tables are.
 */
export function codexToml(text: string, origin?: string, token?: string): string {
    // Back to the user's file first: the block out, their model_provider in again.
    let rest = text
    const start = text.indexOf(BLOCK_START)
    const end = start >= 0 ? text.indexOf(BLOCK_END, start) : -1
    // At the top it is followed by one blank line of the app's, which goes with it.
    if (start === 0 && end >= 0)
        rest = text.slice(end + BLOCK_END.length).replace(/^\r?\n/, '').replace(/^\r?\n/, '')
    else
        rest = withBlock(text, undefined)
    rest = rest.split('\n').map(line => (line.startsWith(CODEX_SET_ASIDE) ? line.slice(CODEX_SET_ASIDE.length) : line)).join('\n')
    if (!origin || !token)
        return rest
    const lines = rest.split('\n')
    const firstTable = lines.findIndex(line => /^\s*\[/.test(line))
    for (let i = 0; i < (firstTable < 0 ? lines.length : firstTable); i++) {
        if (/^\s*model_provider\s*=/.test(lines[i]))
            lines[i] = CODEX_SET_ASIDE + lines[i]
    }
    const provider = `{ name = "Filo", base_url = ${tomlString(`${origin}/v1`)}, wire_api = "responses", experimental_bearer_token = ${tomlString(token)} }`
    const block = `${BLOCK_START}\nmodel_provider = "filo"\nmodel_providers.filo = ${provider}\n${BLOCK_END}\n`
    const body = lines.join('\n')
    return body.trim() ? `${block}\n${body}` : block
}
