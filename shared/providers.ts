// Model providers as pi sees them (its ModelRuntime), for Settings → 模型供应商. Credentials live in
// pi's auth.json and endpoints in its models.json, so the terminal pi uses the same setup.

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
    /** Models usable now (configured providers only). */
    available: number
}

export interface ProviderList {
    providers: ProviderInfo[]
    /** pi could not load models.json; its built-in providers still work. */
    modelsError?: string
}

/** What Settings → 模型供应商 shows: pi's providers plus the models.json entries it edits. */
export interface ProvidersState extends ProviderList {
    endpoints: Endpoint[]
}

export type AuthMethod = 'api_key' | 'oauth'

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

/** Placeholder written for keyless endpoints; pi only needs some value. */
export const KEYLESS_API_KEY = 'none'
