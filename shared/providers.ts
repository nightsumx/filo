// Providers, for Settings → 供应商: an address and a key, shared by every agent whose API a model
// speaks (pi all of them, Claude Code and Codex through their own config, routing groups). They are
// kept in pi's auth.json and models.json, the one library on disk the terminal reads too; pi's
// ModelRuntime reads them back.
import type { ModelHistory } from 'pi-capabilities/lib/channelStore.ts'
import type { ChannelResult, ProbeProgress } from 'pi-capabilities/lib/channelTest.ts'

/** Where a configured provider's credential comes from (pi's AuthStatus.source). */
export type ProviderAuthSource = 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'

export interface ProviderInfo {
    id: string
    name: string
    /** Ships with pi; false for providers only models.json defines. */
    builtIn: boolean
    /** API-key sign-in; `interactive` false means pi only reads ambient credentials (env, profiles). */
    apiKey?: { label: string, interactive: boolean }
    /** Account sign-in (OAuth or device code). */
    oauth?: { label: string, subscription: boolean }
    configured: boolean
    source?: ProviderAuthSource
    /** pi's label for the source, e.g. the environment variable. */
    sourceLabel?: string
    /** Credential saved in auth.json, which logout removes. */
    stored?: 'api_key' | 'oauth'
    models: number
    /** The APIs its models speak: which agents can use it. */
    apis: string[]
    /** Models usable now (configured providers only). */
    available: number
}

export interface ProviderList {
    providers: ProviderInfo[]
    /** pi could not load models.json; its built-in providers still work. */
    modelsError?: string
}

/** What Settings → 供应商 shows: the providers plus the models.json entries it edits. */
export interface ProvidersState extends ProviderList {
    endpoints: Endpoint[]
}

export type AuthMethod = 'api_key' | 'oauth'

/**
 * Providers most people sign in to, shown first in this order (the big subscriptions, then the
 * common key-based ones). pi lists providers alphabetically, which buries OpenAI and Anthropic.
 */
export const POPULAR_PROVIDERS = ['openai', 'anthropic', 'github-copilot', 'google', 'xai', 'openrouter', 'deepseek'] as const

/** Popular providers first, the rest after them in pi's order. */
export function sortProviders<T extends { id: string }>(providers: readonly T[]): T[] {
    const rank = (id: string) => {
        const i = (POPULAR_PROVIDERS as readonly string[]).indexOf(id)
        return i < 0 ? POPULAR_PROVIDERS.length : i
    }
    // Array.prototype.sort is stable, so the unranked keep their order.
    return [...providers].sort((a, b) => rank(a.id) - rank(b.id))
}

/** A question a login flow asks (pi's AuthPrompt). */
export type LoginPrompt =
    | { type: 'text' | 'secret' | 'manual_code', message: string, placeholder?: string }
    | { type: 'select', message: string, options: { id: string, label: string, description?: string }[] }

/** What a login flow reports (pi's AuthEvent). */
export type LoginNotice =
    | { type: 'info', message: string, links?: { url: string, label?: string }[] }
    | { type: 'auth_url', url: string, instructions?: string }
    | { type: 'device_code', userCode: string, verificationUri: string }
    | { type: 'progress', message: string }

/** Main → renderer while a login runs. */
export type LoginUpdate =
    | { login: string, notice: LoginNotice }
    | { login: string, prompt: LoginPrompt, promptId: string }
    /** The flow no longer needs this answer (e.g. the browser callback won over a pasted code). */
    | { login: string, promptGone: string }
    | { login: string, done: true }
    | { login: string, error: string, cancelled?: boolean }

/** Chat APIs a custom endpoint can speak; models.json may name others, which are kept as they are. */
export const ENDPOINT_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type EndpointApi = typeof ENDPOINT_APIS[number]

export interface EndpointModel {
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    reasoning?: boolean
    /** Accepts images (models.json input: ["text", "image"]). */
    images?: boolean
    /** Its own API when not the provider's: one address can serve Claude models over Messages and GPT ones over Responses. */
    api?: string
}

/**
 * A provider entry of models.json as the Settings page edits it. For a built-in provider only the
 * address is changed (a proxy); a custom one also names its API and models. Other fields of the
 * entry are kept when saving.
 */
export interface Endpoint {
    id: string
    name?: string
    baseUrl?: string
    /** Required for custom providers. */
    api?: string
    /** Custom providers only; built-ins keep their own list. */
    models?: EndpointModel[]
    /** models.json has an apiKey (literal, $ENV or !command): shown, never sent to the renderer. */
    hasKey?: boolean
    /** models.json holds the keyless placeholder. */
    keyless?: boolean
}

export interface EndpointSave {
    endpoint: Endpoint
    /** Adding a new provider: refused when the id is taken, instead of editing that provider. */
    create?: boolean
    /** Saved to auth.json; undefined keeps the current key. */
    apiKey?: string
    /**
     * No key at all (local servers): writes a placeholder apiKey to models.json, which is how pi marks
     * a provider usable without credentials.
     */
    keyless?: boolean
}

/** A channel added from an agent's model picker (ProviderService.addChannel): joins the provider with the same address and key. */
export interface ChannelSave {
    baseUrl: string
    /** The agent's API (AGENT_APIS), one of ENDPOINT_APIS. */
    api: string
    apiKey: string
    /** For an endpoint that does not list its models. */
    model?: string
}

/**
 * The base URL pi's client for `api` wants, from the address the user gave: Anthropic's SDK adds
 * /v1 itself, the OpenAI ones expect it in the address.
 */
export function apiBaseUrl(address: string, api: string): string {
    let base = address.trim()
    while (base.endsWith('/'))
        base = base.slice(0, -1)
    if (api === 'anthropic-messages')
        return base.endsWith('/v1') ? base.slice(0, -3) : base
    let path = ''
    try {
        path = new URL(base).pathname
    }
    catch {}
    return path && path !== '/' ? base : `${base}/v1`
}

/** Placeholder written for keyless endpoints; pi only needs some value. */
export const KEYLESS_API_KEY = 'none'

// ---------------------------------------------------------------- channel test

/** A model the channel test can run on (pi-capabilities/lib/channelTest.ts), with pi's prices per million tokens. */
export interface ChannelModel {
    id: string
    name: string
    cost?: { input: number, output: number, cacheRead: number, cacheWrite: number }
}

/** A run under way; it goes on in main when Settings closes, so the page picks it up again. */
export interface ChannelRun {
    test: string
    provider: string
    model: string
    progress?: ProbeProgress
}

/** A run's progress, then its outcome, to every window. */
export type ChannelTestUpdate = ChannelRun & (
    | { progress: ProbeProgress }
    | { result: ChannelResult }
    | { error: string, cancelled?: boolean }
)

/** What the provider page shows next to the test, per "provider/model": the last result, the past week, runs under way. */
export interface ChannelHealth {
    results: Record<string, ChannelResult>
    history: Record<string, ModelHistory>
    running: ChannelRun[]
}
