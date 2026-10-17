// Provider setup for Settings → 供应商, run as its own process by the user's node with the user's
// pi (main passes pi's entry file): the provider list, auth.json format and login flows are then
// exactly those of the pi the threads run, whatever its version. Node ≥22.18 runs this file directly
// (type stripping), and pi needs ≥22.19, so only erasable TypeScript belongs here.
//
// Protocol, one JSON object per line:
//   in   { id, op: 'list' | 'login' | 'logout' | 'setKey' | 'apiKey' | 'routeCatalog' | 'routeTarget' | 'nativeApis', ... }   → out { id, result } | { id, error, cancelled? }
//   in   { id, op: 'probeModels' | 'probe', ... }   channel test: a provider's models, one request
//   in   { id, op: 'prices' }   every model's price and cache lifetime (pi-capabilities/lib/prices PriceList)
//   in   { id, op: 'trust' | 'answerTrust', cwd, label? }   pi's project trust question, and the choice made (→ { trusted, saved })
//   in   { id, op: 'trustState', cwds } / { id, op: 'setTrust', cwd, decision }   what trust.json says of projects, and a change to it (→ ProjectTrust[])
//   in   { op: 'answer', login, promptId, value } | { op: 'cancel', login } | { op: 'probeCancel', probe }
//   out  { update: LoginUpdate }   while a login runs (prompts and notices)
import type * as Pi from '@earendil-works/pi-coding-agent'
import type { ProjectTrust } from '../shared/ipc.ts'
import type { AuthMethod, LoginNotice, LoginPrompt, LoginUpdate, ProviderInfo, ProviderList } from '../shared/providers.ts'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

type Runtime = Awaited<ReturnType<typeof Pi.ModelRuntime.create>>
type Interaction = Parameters<Runtime['login']>[2]
type AuthPrompt = Parameters<Interaction['prompt']>[0]
type AuthEvent = Parameters<Interaction['notify']>[0]

const entry = process.argv[2]
if (!entry) {
    process.stderr.write('usage: providerHelper.mts <pi entry file>\n')
    process.exit(2)
}
const pi: typeof Pi = await import(pathToFileURL(entry).href)

function send(message: Record<string, unknown>) {
    process.stdout.write(`${JSON.stringify(message)}\n`)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---------------------------------------------------------------- list

let builtInIds: Set<string> | undefined

/** A fresh runtime per call: pi reads models.json once at creation, and the user may have edited it. */
async function list(): Promise<ProviderList> {
    const runtime = await pi.ModelRuntime.create()
    builtInIds ??= new Set((await pi.ModelRuntime.create({ modelsPath: null })).getProviders().map(p => p.id))
    const stored = new Map((await runtime.listCredentials()).map(c => [c.providerId, c.type]))
    const providers: ProviderInfo[] = []
    for (const provider of runtime.getProviders()) {
        // Routing's own entry (terminal sync), managed in Settings → 路由.
        if (provider.id === 'filo')
            continue
        const status = runtime.getProviderAuthStatus(provider.id)
        const { apiKey, oauth } = provider.auth
        providers.push({
            id: provider.id,
            name: provider.name,
            builtIn: builtInIds.has(provider.id),
            apiKey: apiKey ? { label: apiKey.name, interactive: !!apiKey.login } : undefined,
            oauth: oauth ? { label: oauth.loginLabel ?? oauth.name, subscription: oauth.isSubscription === true } : undefined,
            configured: status.configured,
            source: status.source,
            sourceLabel: status.label,
            stored: stored.get(provider.id),
            models: runtime.getModels(provider.id).length,
            apis: [...new Set(runtime.getModels(provider.id).map(m => m.api))],
            // Availability can run a models.json `!command`, so only for providers that claim a key.
            available: status.configured ? (await runtime.getAvailable(provider.id).catch(() => [])).length : 0,
        })
    }
    return { providers, modelsError: runtime.getError() }
}

// ---------------------------------------------------------------- login

interface Login {
    controller: AbortController
    prompts: Map<string, { resolve: (value: string) => void, reject: (error: Error) => void }>
}

const logins = new Map<string, Login>()
let promptSeq = 0

/** Only the fields the renderer shows; pi's objects carry signals and may grow fields. */
function promptOf(prompt: AuthPrompt): LoginPrompt {
    if (prompt.type === 'select')
        return { type: 'select', message: prompt.message, options: prompt.options.map(o => ({ id: o.id, label: o.label, description: o.description })) }
    return { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder }
}

function noticeOf(event: AuthEvent): LoginNotice {
    switch (event.type) {
        case 'auth_url':
            return { type: 'auth_url', url: event.url, instructions: event.instructions }
        case 'device_code':
            return { type: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri }
        case 'info':
            return { type: 'info', message: event.message, links: event.links?.map(l => ({ url: l.url, label: l.label })) }
        default:
            return { type: 'progress', message: event.message }
    }
}

function update(value: LoginUpdate) {
    send({ update: value })
}

async function login(id: string, providerId: string, method: AuthMethod) {
    const controller = new AbortController()
    const state: Login = { controller, prompts: new Map() }
    logins.set(id, state)
    const interaction: Interaction = {
        signal: controller.signal,
        prompt: prompt => new Promise<string>((resolve, reject) => {
            if (prompt.signal?.aborted || controller.signal.aborted)
                return reject(new Error('Login cancelled'))
            const promptId = String(++promptSeq)
            state.prompts.set(promptId, { resolve, reject })
            prompt.signal?.addEventListener('abort', () => {
                if (!state.prompts.delete(promptId))
                    return
                update({ login: id, promptGone: promptId })
                reject(new Error('Login cancelled'))
            }, { once: true })
            update({ login: id, prompt: promptOf(prompt), promptId })
        }),
        notify: event => update({ login: id, notice: noticeOf(event) }),
    }
    // The id pi's own /login sends (settings.json deviceId, created on first use), so the app and the
    // terminal count as one installation.
    const settings = pi.SettingsManager.create(os.homedir())
    try {
        await (await pi.ModelRuntime.create()).login(providerId, method, interaction, { getDeviceId: () => settings.getOrCreateDeviceId() })
    }
    finally {
        await settings.flush().catch(() => {})
        logins.delete(id)
        for (const pending of state.prompts.values())
            pending.reject(new Error('Login cancelled'))
    }
}

function cancel(id: string) {
    const state = logins.get(id)
    if (!state)
        return
    state.controller.abort()
    for (const pending of state.prompts.values())
        pending.reject(new Error('Login cancelled'))
    state.prompts.clear()
}

/** API key from a form (custom endpoints): pi's own api-key login, answered without asking. */
async function setKey(providerId: string, key: string) {
    const interaction: Interaction = {
        prompt: async (prompt) => {
            if (prompt.type === 'secret' || prompt.type === 'text')
                return key
            throw new Error(`${providerId} asks more than a key; use its sign-in instead`)
        },
        notify: () => {},
    }
    await (await pi.ModelRuntime.create()).login(providerId, 'api_key', interaction)
}

// ---------------------------------------------------------------- routing

const ROUTE_APIS = new Set(['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'])

const stringHeaders = (headers: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (headers && typeof headers === 'object') {
        for (const [name, value] of Object.entries(headers)) {
            if (typeof value === 'string')
                out[name] = value
        }
    }
    return out
}

/**
 * The API each model id speaks at its maker, from pi's own catalog (Anthropic's and OpenAI's): what
 * a relay listing both kinds most likely serves it over. Ids pi does not know are left out.
 */
async function nativeApis(ids: string[]) {
    const runtime = await pi.ModelRuntime.create({ modelsPath: null })
    const out: Record<string, string> = {}
    for (const id of ids) {
        const model = runtime.getModel('anthropic', id) ?? runtime.getModel('openai', id)
        if (model)
            out[id] = model.api
    }
    return out
}

/**
 * Models the gateway can route to (shared/routes RouteCatalog): those of providers signed in with a
 * key, on an API the gateway relays. Subscription sign-ins are left out: their tokens are for the
 * vendor's own clients.
 */
async function routeCatalog() {
    const runtime = await pi.ModelRuntime.create()
    const models: Record<string, unknown>[] = []
    const skipped: { provider: string, name: string, reason: 'subscription' | 'api' }[] = []
    for (const provider of runtime.getProviders()) {
        // The app's own groups (terminal sync writes them to models.json): a group in a group loops.
        if (provider.id === 'filo' || !runtime.getProviderAuthStatus(provider.id).configured)
            continue
        if (runtime.isUsingOAuth(provider.id)) {
            skipped.push({ provider: provider.id, name: provider.name, reason: 'subscription' })
            continue
        }
        const available = await runtime.getAvailable(provider.id).catch(() => [])
        const usable = available.filter(m => ROUTE_APIS.has(m.api))
        if (available.length && !usable.length)
            skipped.push({ provider: provider.id, name: provider.name, reason: 'api' })
        for (const m of usable) {
            models.push({
                provider: provider.id,
                providerName: provider.name,
                id: m.id,
                name: m.name || m.id,
                api: m.api,
                contextWindow: m.contextWindow,
                maxTokens: m.maxTokens,
                reasoning: m.reasoning,
                images: Array.isArray(m.input) && m.input.includes('image'),
                thinkingLevelMap: m.thinkingLevelMap,
                compat: (m as { compat?: unknown }).compat,
            })
        }
    }
    return { models, skipped, error: runtime.getError() }
}

/** Where and with what key a provider serves a model, as pi would send the request. */
async function routeTarget(providerId: string, modelId: string) {
    const runtime = await pi.ModelRuntime.create()
    const model = runtime.getModel(providerId, modelId)
    if (!model)
        throw new Error(`model-gone: ${providerId}/${modelId} is not in pi's model list`)
    if (runtime.isUsingOAuth(providerId))
        throw new Error(`no-key: ${providerId} is signed in with a subscription`)
    const result = await runtime.getAuth(model).catch(() => undefined)
    const auth = result?.auth
    if (!auth?.apiKey && !auth?.headers)
        throw new Error(`no-key: no key for ${providerId}`)
    return {
        api: model.api,
        baseUrl: auth.baseUrl || model.baseUrl,
        apiKey: auth.apiKey,
        headers: { ...stringHeaders((model as { headers?: unknown }).headers), ...stringHeaders(auth.headers) },
    }
}

/** What Claude Code and Codex requests are counted at: pi's whole model list, models.json included. */
async function prices() {
    const runtime = await pi.ModelRuntime.create()
    const out: Record<string, unknown> = {}
    for (const m of runtime.getModels())
        out[`${m.provider}/${m.id}`] = { cost: m.cost, promptCache: m.promptCache }
    return out
}

// ---------------------------------------------------------------- channel test

/** A provider's models with pi's prices, for the channel test's model choice. */
async function probeModels(providerId: string) {
    const runtime = await pi.ModelRuntime.create()
    const models = await runtime.getAvailable(providerId).catch(() => [])
    return models.filter(m => m.type === undefined || m.type === 'chat').map(m => ({ id: m.id, name: m.name || m.id, cost: m.cost && { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } }))
}

const probes = new Map<string, AbortController>()

/**
 * One request of a channel test (pi-capabilities/lib/channelTest.ts ProbeRequest → ProbeReply), sent
 * the way a thread would send it. pi-cc-tui's /channel-test does the same through its model registry.
 */
async function probe(id: string, providerId: string, modelId: string, request: Record<string, any>) {
    const controller = new AbortController()
    probes.set(id, controller)
    try {
        const runtime = await pi.ModelRuntime.create()
        const model = runtime.getModel(providerId, modelId)
        if (!model)
            throw new Error(`${providerId}/${modelId} is not in pi's model list`)
        const now = Date.now()
        const messages = (request.turns as any[]).map(t => (t.role === 'user' ? { role: 'user' as const, content: String(t.text), timestamp: now } : t.message))
        const started = performance.now()
        let ttftMs: number | null = null
        const stream = runtime.streamSimple(model, { systemPrompt: String(request.system), messages }, { maxTokens: Number(request.maxTokens), sessionId: String(request.sessionId), signal: controller.signal })
        for await (const event of stream) {
            if (ttftMs === null && (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta'))
                ttftMs = performance.now() - started
        }
        const message = await stream.result()
        const u = message.usage
        if (message.stopReason === 'aborted' || controller.signal.aborted)
            throw Object.assign(new Error('Channel test cancelled'), { name: 'AbortError' })
        return {
            message,
            usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total },
            ttftMs,
            durationMs: performance.now() - started,
            error: message.stopReason === 'error' ? message.errorMessage || 'request failed' : undefined,
        }
    }
    finally {
        probes.delete(id)
    }
}

// ---------------------------------------------------------------- project trust

/** pi's choices for its trust question (core/trust-manager.js getProjectTrustOptions, session-only ones included). */
function trustOptions(cwd: string): { label: string, trusted: boolean, updates: Pi.ProjectTrustUpdate[] }[] {
    let real = path.resolve(cwd)
    try {
        real = realpathSync(real)
    }
    catch {}
    const parent = path.dirname(real)
    return [
        { label: 'Trust', trusted: true, updates: [{ path: real, decision: true }] },
        ...(parent === real ? [] : [{ label: `Trust parent folder (${parent})`, trusted: true, updates: [{ path: parent, decision: true }, { path: real, decision: null }] }]),
        { label: 'Trust (this session only)', trusted: true, updates: [] },
        { label: 'Do not trust', trusted: false, updates: [{ path: real, decision: false }] },
        { label: 'Do not trust (this session only)', trusted: false, updates: [] },
    ]
}

/** What pi's TUI asks before it starts in `cwd` (core/project-trust.js), or null when it would not ask. */
function trustQuestion(cwd: string): { title: string, message: string, options: string[] } | null {
    if (!pi.hasTrustRequiringProjectResources(cwd) || new pi.ProjectTrustStore(pi.getAgentDir()).get(cwd) !== null)
        return null
    if (pi.SettingsManager.create(cwd, pi.getAgentDir()).getDefaultProjectTrust() !== 'ask')
        return null
    return {
        title: 'Trust project folder?',
        message: `${cwd}

This allows pi to load ${pi.CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.`,
        options: trustOptions(cwd).map(o => o.label),
    }
}

/** Saves the choice as pi's TUI does; no choice is not trusting, for this session. */
function answerTrust(cwd: string, label: string | undefined): { trusted: boolean, saved: boolean } {
    const option = trustOptions(cwd).find(o => o.label === label)
    if (option?.updates.length)
        new pi.ProjectTrustStore(pi.getAgentDir()).setMany(option.updates)
    return { trusted: option?.trusted ?? false, saved: !!option?.updates.length }
}

/** What pi's trust.json and defaultProjectTrust say of each project (Settings → Project trust). */
function trustState(cwds: string[]): ProjectTrust[] {
    const store = new pi.ProjectTrustStore(pi.getAgentDir())
    const fallback = pi.SettingsManager.create(os.homedir(), pi.getAgentDir()).getDefaultProjectTrust()
    return cwds.map((cwd) => {
        let real = path.resolve(cwd)
        try {
            real = realpathSync(real)
        }
        catch {}
        const entry = store.getEntry(cwd)
        return {
            cwd,
            decision: entry?.decision ?? null,
            inheritedFrom: entry && entry.path !== real ? entry.path : undefined,
            fallback,
            gated: pi.hasTrustRequiringProjectResources(cwd),
        }
    })
}

/** null forgets the project's own decision; a decision on a parent folder still applies. */
function setTrust(cwd: string, decision: boolean | null) {
    new pi.ProjectTrustStore(pi.getAgentDir()).set(cwd, decision)
}

// ---------------------------------------------------------------- loop

async function handle(message: Record<string, any>) {
    const { id, op } = message
    if (op === 'answer') {
        const state = logins.get(String(message.login))
        const pending = state?.prompts.get(String(message.promptId))
        if (pending) {
            state!.prompts.delete(String(message.promptId))
            pending.resolve(String(message.value ?? ''))
        }
        return
    }
    if (op === 'cancel')
        return cancel(String(message.login))
    if (op === 'probeCancel')
        return probes.get(String(message.probe))?.abort()
    try {
        let result: unknown = null
        if (op === 'list')
            result = await list()
        else if (op === 'login')
            await login(String(id), String(message.provider), message.method === 'oauth' ? 'oauth' : 'api_key')
        else if (op === 'logout')
            await (await pi.ModelRuntime.create()).logout(String(message.provider))
        else if (op === 'setKey')
            await setKey(String(message.provider), String(message.key))
        else if (op === 'routeCatalog')
            result = await routeCatalog()
        else if (op === 'routeTarget')
            result = await routeTarget(String(message.provider), String(message.model))
        else if (op === 'probeModels')
            result = await probeModels(String(message.provider))
        else if (op === 'probe')
            result = await probe(String(id), String(message.provider), String(message.model), message.request ?? {})
        else if (op === 'prices')
            result = await prices()
        else if (op === 'nativeApis')
            result = await nativeApis(Array.isArray(message.models) ? message.models.map(String) : [])
        else if (op === 'trust')
            result = trustQuestion(String(message.cwd))
        else if (op === 'answerTrust')
            result = answerTrust(String(message.cwd), typeof message.label === 'string' ? message.label : undefined)
        else if (op === 'trustState')
            result = trustState(Array.isArray(message.cwds) ? message.cwds.map(String) : [])
        else if (op === 'setTrust') {
            setTrust(String(message.cwd), typeof message.decision === 'boolean' ? message.decision : null)
            result = trustState([String(message.cwd)])
        }
        else if (op === 'apiKey')
            result = (await (await pi.ModelRuntime.create()).getAuth(String(message.provider)).catch(() => undefined))?.auth.apiKey ?? null
        else
            throw new Error(`unknown op ${op}`)
        send({ id, result })
    }
    catch (error) {
        const text = errorText(error)
        send({ id, error: text, cancelled: text === 'Login cancelled' || (error instanceof Error && error.name === 'AbortError') || undefined })
    }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line)
            continue
        let message: Record<string, any>
        try {
            message = JSON.parse(line)
        }
        catch {
            continue
        }
        void handle(message)
    }
})
// Main went away (or closed the pipe to stop this helper).
process.stdin.on('end', () => process.exit(0))
send({ ready: true })
