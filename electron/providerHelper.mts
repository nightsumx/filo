// Provider setup for Settings → 模型供应商, run as its own process by the user's node with the user's
// pi (main passes pi's entry file): the provider list, auth.json format and login flows are then
// exactly those of the pi the threads run, whatever its version. Node ≥22.18 runs this file directly
// (type stripping), and pi needs ≥22.19, so only erasable TypeScript belongs here.
//
// Protocol, one JSON object per line:
//   in   { id, op: 'list' | 'login' | 'logout' | 'setKey' | 'apiKey', ... }   → out { id, result } | { id, error, cancelled? }
//   in   { op: 'answer', login, promptId, value } | { op: 'cancel', login }
//   out  { update: LoginUpdate }   while a login runs (prompts and notices)
import type * as Pi from '@earendil-works/pi-coding-agent'
import type { AuthMethod, LoginNotice, LoginPrompt, LoginUpdate, ProviderInfo, ProviderList } from '../shared/providers.ts'
import os from 'node:os'
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
