// What a Claude Code or Codex request costs, at the prices in pi's model list: the one list pi, Filo
// and pi-cc-tui count with. A subscription's requests are counted at the maker's list price, the same
// as a key's, so the figures of every agent add up and compare.

/** pi's Model['cost']: USD per million tokens; a tier applies past its prompt size. */
export interface Price {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    tiers?: { inputTokensAbove: number, input: number, output: number, cacheRead: number, cacheWrite: number }[]
}

export interface PricedModel {
    cost?: Price
    /** pi's Model['promptCache'], in seconds. */
    promptCache?: { short?: number, long?: number }
}

/** pi's model list, `provider/id` → model. */
export type PriceList = Record<string, PricedModel>

/** A request's tokens as pi counts them: input without the cache reads and writes. */
export interface Tokens {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    /** Of cacheWrite: Anthropic's one-hour writes, billed at twice the input price. */
    cacheWrite1h?: number
}

/** The providers of pi's that list each agent's maker's models. */
const MAKERS = { claude: ['anthropic'], codex: ['openai', 'openai-codex'] }

export type Maker = keyof typeof MAKERS

/** The model an agent's model id is priced as: its maker's entry, else any provider listing the id with a price. */
export function pricedModel(prices: PriceList, maker: Maker, id: string | undefined): (PricedModel & { key: string }) | undefined {
    if (!id)
        return undefined
    for (const provider of MAKERS[maker]) {
        const model = prices[`${provider}/${id}`]
        if (model)
            return { key: `${provider}/${id}`, ...model }
    }
    for (const [key, model] of Object.entries(prices)) {
        if (key.endsWith(`/${id}`) && model.cost?.input)
            return { key, ...model }
    }
    return undefined
}

/** pi-ai's calculateCost: zero without a price. */
export function costOf(price: Price | undefined, t: Tokens) {
    let rates: Omit<Price, 'tiers'> = price ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let above = -1
    for (const tier of price?.tiers ?? []) {
        if (t.input + t.cacheRead + t.cacheWrite > tier.inputTokensAbove && tier.inputTokensAbove > above) {
            rates = tier
            above = tier.inputTokensAbove
        }
    }
    const long = t.cacheWrite1h ?? 0
    const cost = {
        input: rates.input * t.input / 1e6,
        output: rates.output * t.output / 1e6,
        cacheRead: rates.cacheRead * t.cacheRead / 1e6,
        cacheWrite: (rates.cacheWrite * (t.cacheWrite - long) + rates.input * 2 * long) / 1e6,
        total: 0,
    }
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite
    return cost
}

/** An Anthropic Messages `usage` (Claude Code's session records): input already leaves the cache out. */
export function claudeTokens(u: any): Tokens | undefined {
    if (typeof u?.input_tokens !== 'number')
        return undefined
    const num = (v: unknown) => (typeof v === 'number' ? v : 0)
    return { input: u.input_tokens, output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens) }
}

