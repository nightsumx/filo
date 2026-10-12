import type { AssistantMessage, PiModel } from '@shared/pi'

/**
 * Rough price of re-reading `tokens` of context without the cache. Providers that bill cache writes
 * (Anthropic) write the prefix again at that rate; the rest bill it as plain input. Uses the current
 * model's price list, else the per-token rate the last reply was billed at. Null when unknown or free.
 */
export function uncachedCost(tokens: number, model: PiModel | undefined, reply: AssistantMessage | undefined): number | null {
    let perToken = 0
    if (model?.cost)
        perToken = (model.cost.cacheWrite || model.cost.input) / 1e6
    else if (reply?.usage) {
        const u = reply.usage
        perToken = u.cacheWrite > 0 ? u.cost.cacheWrite / u.cacheWrite : u.input > 0 ? u.cost.input / u.input : 0
    }
    return perToken > 0 ? tokens * perToken : null
}

/** Context size: pi's own estimate, else everything the last reply read and wrote. */
export function contextTokens(statsTokens: number | null | undefined, reply: AssistantMessage | undefined): number | null {
    if (statsTokens)
        return statsTokens
    const u = reply?.usage
    const total = u ? u.input + u.cacheRead + u.cacheWrite + u.output : 0
    return total > 0 ? total : null
}
