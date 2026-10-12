// routes: the desktop app's routing groups as pi models. Each group (Settings → 路由) is a model of
// the `filo` provider at the app's local gateway, which sends every request to the group's members
// in order and moves to the next one when a member fails before answering. Picking another group is
// picking another model.
//
// Not a capability: the app loads it while there are groups and passes, in the environment, the
// gateway address, this process's key and the groups. Which one a thread uses is its model.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

interface GroupModel {
    id: string
    name: string
    api: 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai'
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    images: boolean
    thinkingLevelMap?: Record<string, unknown>
    compat?: Record<string, unknown>
}

export const PROVIDER = 'filo'

/** pi's clients add the API's path to these. */
function baseUrl(origin: string, api: GroupModel['api']) {
    if (api === 'anthropic-messages')
        return origin
    if (api === 'google-generative-ai')
        return `${origin}/v1beta`
    return `${origin}/v1`
}

function groups(): GroupModel[] {
    try {
        const list = JSON.parse(process.env.FILO_ROUTE_MODELS ?? '[]')
        return Array.isArray(list) ? list.filter(g => g && typeof g.id === 'string' && typeof g.api === 'string') : []
    }
    catch {
        return []
    }
}

export default function routes(pi: ExtensionAPI) {
    const origin = process.env.FILO_GATEWAY_URL
    const list = groups()
    if (!origin || !process.env.FILO_GATEWAY_KEY || !list.length)
        return
    pi.registerProvider(PROVIDER, {
        name: 'Filo',
        baseUrl: `${origin}/v1`,
        apiKey: '$FILO_GATEWAY_KEY',
        models: list.map(g => ({
            id: g.id,
            name: g.name,
            api: g.api,
            baseUrl: baseUrl(origin, g.api),
            reasoning: g.reasoning,
            input: g.images ? ['text', 'image'] : ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: g.contextWindow,
            maxTokens: g.maxTokens,
            ...(g.thinkingLevelMap ? { thinkingLevelMap: g.thinkingLevelMap } : {}),
            ...(g.compat ? { compat: g.compat } : {}),
        }) as any),
    })
}
