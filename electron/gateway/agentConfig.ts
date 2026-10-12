// Edits to agents' own config files that routing needs, kept to a marked block the app owns, so the
// rest of the file stays byte for byte as the user wrote it and the block can be taken out again.

import type { RouteGroup } from '@shared/routes'

export const BLOCK_START = '# >>> filo routing: written by Filo while its routing is on; edits here are replaced'
export const BLOCK_END = '# <<< filo routing'

/** `text` with the app's block replaced by `block` (or removed when `block` is undefined). */
export function withBlock(text: string, block: string | undefined): string {
    const start = text.indexOf(BLOCK_START)
    const end = start >= 0 ? text.indexOf(BLOCK_END, start) : -1
    let rest = text
    if (start >= 0 && end >= 0) {
        const after = text.slice(end + BLOCK_END.length).replace(/^\r?\n/, '')
        const before = text.slice(0, start).replace(/\n{2,}$/, '\n')
        rest = before + after
    }
    if (!block)
        return rest
    const body = `${BLOCK_START}\n${block.trimEnd()}\n${BLOCK_END}\n`
    if (!rest.trim())
        return body
    return `${rest.replace(/\s*$/, '\n')}\n${body}`
}

/** A TOML basic string. */
export const tomlString = (value: string) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** The model id Grok shows for a group. */
export const grokModelId = (group: string) => `filo-${group}`

const GROK_BACKEND: Partial<Record<RouteGroup['api'], string>> = {
    'openai-completions': 'chat_completions',
    'openai-responses': 'responses',
    'anthropic-messages': 'messages',
}

/**
 * Grok Build models for the groups it can use, pointing at the gateway. The key comes from the
 * process environment (FILO_GATEWAY_KEY), so each Grok process the app starts has its own session.
 * A Grok started from a terminal lists them too but has no key for them (the app removes the block
 * when it quits).
 */
export function grokBlock(groups: RouteGroup[], origin: string, options: { contextWindow?: (group: RouteGroup) => number | undefined } = {}): string | undefined {
    const lines: string[] = []
    for (const group of groups) {
        const backend = GROK_BACKEND[group.api]
        if (!backend)
            continue
        lines.push(
            `[model.${tomlString(grokModelId(group.id))}]`,
            `model = ${tomlString(group.id)}`,
            `name = ${tomlString(`Filo · ${group.name}`)}`,
            `base_url = ${tomlString(`${origin}/v1`)}`,
            `api_backend = ${tomlString(backend)}`,
            `env_key = "FILO_GATEWAY_KEY"`,
        )
        const window = options.contextWindow?.(group)
        if (window)
            lines.push(`context_window = ${Math.floor(window)}`)
        lines.push('')
    }
    return lines.length ? lines.join('\n') : undefined
}
