// Settings → 模型供应商, main side. Sign-in and the provider list go through providerHelper.mts, a
// child process running the user's own pi (so they match the threads exactly); endpoints are edited
// in pi's models.json here, then checked by loading them in that pi.
import type { PiEnv } from '@shared/ipc'
import type { AuthMethod, Endpoint, EndpointModel, EndpointSave, LoginUpdate, ProviderList, ProvidersState } from '@shared/providers'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { ENDPOINT_APIS, KEYLESS_API_KEY } from '@shared/providers'
import { tr } from './i18n'
import { JsonlSplitter } from './jsonl'
import { agentDir } from './piSettings'
import { piSpawnEnv } from './pi-env'

const PI_PACKAGE = '@earendil-works/pi-coding-agent'

/**
 * pi's SDK entry next to its CLI: the bin (e.g. dist/bundle/cli.js) lives inside the package, whose
 * package.json names the import entry. undefined for a compiled pi binary, which has no SDK to load.
 */
export function piEntry(piPath: string): string | undefined {
    let dir: string
    try {
        dir = path.dirname(realpathSync(piPath))
    }
    catch {
        return undefined
    }
    for (; ;) {
        const manifest = path.join(dir, 'package.json')
        if (existsSync(manifest)) {
            try {
                const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
                if (pkg?.name === PI_PACKAGE) {
                    const main = pkg.exports?.['.']?.import ?? pkg.main
                    const file = typeof main === 'string' ? path.join(dir, main) : ''
                    return file && existsSync(file) ? file : undefined
                }
            }
            catch {}
        }
        const parent = path.dirname(dir)
        if (parent === dir)
            return undefined
        dir = parent
    }
}

// ---------------------------------------------------------------- helper process

export interface HelperLaunch {
    node: string
    /** providerHelper.mts */
    script: string
    /** pi's SDK entry (piEntry). */
    entry: string
    env: Record<string, string>
}

interface Pending {
    resolve: (value: any) => void
    reject: (error: Error & { cancelled?: boolean }) => void
}

/** Quits after this long without requests or a login in progress; the next request starts it again. */
const IDLE_MS = 60_000

/**
 * The helper child: requests are answered in any order by id. It starts on first use and stops when
 * idle, so the app does not keep a node process around for a page that is rarely open.
 */
export class ProviderHelper {
    private child: ChildProcessWithoutNullStreams | null = null
    private pending = new Map<string, Pending>()
    private logins = new Set<string>()
    private seq = 0
    private idle: ReturnType<typeof setTimeout> | undefined
    private stderr = ''

    constructor(private launch: () => Promise<HelperLaunch>, private onUpdate: (update: LoginUpdate) => void) {}

    private async start(): Promise<ChildProcessWithoutNullStreams> {
        if (this.child)
            return this.child
        const launch = await this.launch()
        if (this.child)
            return this.child
        const child = spawn(launch.node, [launch.script, launch.entry], { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
        this.child = child
        this.stderr = ''
        const splitter = new JsonlSplitter((line) => {
            let message: any
            try {
                message = JSON.parse(line)
            }
            catch {
                return
            }
            if (message?.update) {
                this.onUpdate(message.update)
                return
            }
            const waiter = typeof message?.id === 'string' ? this.pending.get(message.id) : undefined
            if (!waiter)
                return
            this.pending.delete(message.id)
            if ('error' in message)
                waiter.reject(Object.assign(new Error(String(message.error)), { cancelled: !!message.cancelled }))
            else
                waiter.resolve(message.result)
            this.scheduleIdle()
        })
        child.stdout.on('data', chunk => splitter.push(chunk))
        child.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk).slice(-8000)
        })
        const failAll = (reason: string) => {
            if (this.child === child)
                this.child = null
            for (const waiter of this.pending.values())
                waiter.reject(new Error(reason))
            this.pending.clear()
            for (const login of this.logins)
                this.onUpdate({ login, error: reason })
            this.logins.clear()
        }
        child.on('error', error => failAll(`${tr('无法启动 pi：', 'Could not start pi: ')}${error.message}`))
        child.on('exit', (code) => {
            const detail = this.stderr.trim().split('\n').slice(-3).join('\n')
            failAll(code === 0 ? tr('pi 已退出', 'pi exited') : `${tr('pi 异常退出', 'pi exited unexpectedly')}${detail ? `: ${detail}` : ''}`)
        })
        return child
    }

    private scheduleIdle() {
        clearTimeout(this.idle)
        if (this.pending.size || this.logins.size)
            return
        this.idle = setTimeout(() => this.stop(), IDLE_MS)
        this.idle.unref?.()
    }

    private async call<T>(message: Record<string, unknown>, id = String(++this.seq)): Promise<T> {
        clearTimeout(this.idle)
        const child = await this.start()
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            child.stdin.write(`${JSON.stringify({ ...message, id })}\n`)
        })
    }

    private post(message: Record<string, unknown>) {
        this.child?.stdin.write(`${JSON.stringify(message)}\n`)
    }

    list(): Promise<ProviderList> {
        return this.call({ op: 'list' })
    }

    logout(provider: string): Promise<void> {
        return this.call({ op: 'logout', provider })
    }

    setKey(provider: string, key: string): Promise<void> {
        return this.call({ op: 'setKey', provider, key })
    }

    /** The key pi would send for a provider (any source); main only uses it to list an endpoint's models. */
    apiKey(provider: string): Promise<string | null> {
        return this.call({ op: 'apiKey', provider })
    }

    /** Starts a login; its prompts, notices and outcome arrive through onUpdate under the returned id. */
    login(provider: string, method: AuthMethod): string {
        const login = `login-${++this.seq}`
        this.logins.add(login)
        this.call({ op: 'login', provider, method }, login).then(
            () => this.onUpdate({ login, done: true }),
            (error: Error & { cancelled?: boolean }) => this.onUpdate({ login, error: error.message, cancelled: error.cancelled || undefined }),
        ).finally(() => {
            this.logins.delete(login)
            this.scheduleIdle()
        })
        return login
    }

    answer(login: string, promptId: string, value: string) {
        this.post({ op: 'answer', login, promptId, value })
    }

    cancel(login: string) {
        this.post({ op: 'cancel', login })
    }

    stop() {
        clearTimeout(this.idle)
        this.child?.stdin.end()
        this.child = null
    }
}

/** How main launches the helper: the node and pi the threads use. */
export function helperLaunch(env: PiEnv, script: string): HelperLaunch {
    const entry = piEntry(env.piPath)
    if (!entry || !env.nodePath)
        throw new Error(tr('这个 pi 安装没有附带 SDK，无法在 Pi 里配置供应商。请在终端运行 pi，然后用 /login。', 'This pi install has no SDK, so providers can\'t be set up here. Run pi in a terminal and use /login.'))
    return { node: env.nodePath, script, entry, env: piSpawnEnv(env) }
}

// ---------------------------------------------------------------- models.json

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

export const modelsJsonPath = () => path.join(agentDir(), 'models.json')

function endpointModelOf(raw: Record<string, any>): EndpointModel {
    const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined)
    return {
        id: String(raw.id),
        name: typeof raw.name === 'string' ? raw.name : undefined,
        contextWindow: count(raw.contextWindow),
        maxTokens: count(raw.maxTokens),
        reasoning: typeof raw.reasoning === 'boolean' ? raw.reasoning : undefined,
        images: Array.isArray(raw.input) ? raw.input.includes('image') : undefined,
    }
}

/** The provider entries of models.json, without key values. */
export function readEndpoints(json: Record<string, any>): Endpoint[] {
    const providers = isObject(json.providers) ? json.providers : {}
    return Object.entries(providers).filter(([, entry]) => isObject(entry)).map(([id, entry]) => ({
        id,
        name: typeof entry.name === 'string' ? entry.name : undefined,
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined,
        api: typeof entry.api === 'string' ? entry.api : undefined,
        models: Array.isArray(entry.models) ? entry.models.filter((m: unknown) => isObject(m) && typeof m.id === 'string').map(endpointModelOf) : undefined,
        hasKey: typeof entry.apiKey === 'string' && entry.apiKey !== '' && entry.apiKey !== KEYLESS_API_KEY,
        keyless: entry.apiKey === KEYLESS_API_KEY || undefined,
    }))
}

const ID_PATTERN = /^[a-z0-9][\w.-]{0,63}$/i
const MAX_TOKENS = 100_000_000

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const tokens = (v: unknown) => (typeof v === 'number' ? v : undefined)
const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

/** An EndpointSave from IPC with only the expected fields and types; values are checked by checkEndpoint. */
export function endpointSaveOf(value: unknown): EndpointSave {
    const save = isObject(value) ? value : {}
    const endpoint = isObject(save.endpoint) ? save.endpoint : {}
    return {
        endpoint: {
            id: text(endpoint.id, 200) ?? '',
            name: text(endpoint.name, 200),
            baseUrl: text(endpoint.baseUrl, 2000),
            api: text(endpoint.api, 100),
            models: Array.isArray(endpoint.models)
                ? endpoint.models.slice(0, 500).filter(isObject).map(m => ({
                        id: text(m.id, 300) ?? '',
                        name: text(m.name, 300),
                        contextWindow: tokens(m.contextWindow),
                        maxTokens: tokens(m.maxTokens),
                        reasoning: flag(m.reasoning),
                        images: flag(m.images),
                    }))
                : undefined,
        },
        apiKey: text(save.apiKey, 8192),
        keyless: flag(save.keyless),
        create: flag(save.create),
    }
}

/** What is wrong with a save, in the UI language; undefined when it can be written. */
export function checkEndpoint(save: EndpointSave, builtIn: boolean, currentApi?: string): string | undefined {
    const { endpoint } = save
    if (!ID_PATTERN.test(endpoint.id))
        return tr('ID 只能用字母、数字、点、下划线和连字符，最多 64 个字符', 'The ID may use letters, digits, dots, underscores and hyphens, up to 64 characters')
    if (endpoint.baseUrl !== undefined && endpoint.baseUrl !== '') {
        let url: URL
        try {
            url = new URL(endpoint.baseUrl)
        }
        catch {
            return tr('地址不是有效的 URL', 'The address is not a valid URL')
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return tr('地址要以 http:// 或 https:// 开头', 'The address must start with http:// or https://')
    }
    if (builtIn)
        return undefined
    if (!endpoint.baseUrl)
        return tr('填写接口地址', 'Enter the API address')
    // An API models.json already names is kept even if the page does not offer it.
    if (!endpoint.api || (!(ENDPOINT_APIS as readonly string[]).includes(endpoint.api) && endpoint.api !== currentApi))
        return tr('选择接口类型', 'Choose the API type')
    const models = endpoint.models ?? []
    if (!models.length)
        return tr('至少添加一个模型', 'Add at least one model')
    const ids = new Set<string>()
    for (const model of models) {
        const id = model.id.trim()
        if (!id)
            return tr('模型 ID 不能为空', 'Model IDs can\'t be empty')
        if (ids.has(id))
            return tr(`模型 ${id} 重复了`, `Model ${id} is listed twice`)
        ids.add(id)
        for (const n of [model.contextWindow, model.maxTokens]) {
            if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0 || n > MAX_TOKENS))
                return tr(`模型 ${id} 的 token 数无效`, `Model ${id} has an invalid token count`)
        }
    }
    if (save.apiKey !== undefined && save.apiKey.length > 4096)
        return tr('API key 太长', 'The API key is too long')
    return undefined
}

/**
 * Writes an endpoint into models.json: only the fields the page edits change, everything else in the
 * entry (headers, compat, modelOverrides, per-model cost…) and other providers stay as they were. For
 * a built-in provider an empty address removes the override.
 */
export function applyEndpoint(json: Record<string, any>, save: EndpointSave, builtIn: boolean): Record<string, any> {
    const { endpoint } = save
    const providers: Record<string, any> = isObject(json.providers) ? { ...json.providers } : {}
    const entry: Record<string, any> = isObject(providers[endpoint.id]) ? { ...providers[endpoint.id] } : {}
    const set = (key: string, value: unknown) => {
        if (value === undefined || value === '')
            delete entry[key]
        else
            entry[key] = value
    }
    set('baseUrl', endpoint.baseUrl?.trim().replace(/\/+$/, ''))
    if (!builtIn) {
        set('name', endpoint.name?.trim())
        set('api', endpoint.api)
        const previous = new Map<string, Record<string, any>>((Array.isArray(entry.models) ? entry.models : [])
            .filter((m: unknown) => isObject(m) && typeof m.id === 'string')
            .map((m: Record<string, any>) => [m.id, m]))
        entry.models = (endpoint.models ?? []).map((model) => {
            const id = model.id.trim()
            const next: Record<string, any> = { ...previous.get(id), id }
            const put = (key: string, value: unknown) => {
                if (value === undefined || value === '')
                    delete next[key]
                else
                    next[key] = value
            }
            put('name', model.name?.trim())
            put('contextWindow', model.contextWindow)
            put('maxTokens', model.maxTokens)
            put('reasoning', model.reasoning)
            if (model.images !== undefined) {
                const input: string[] = Array.isArray(next.input) ? next.input.filter((i: unknown) => i !== 'image') : ['text']
                next.input = model.images ? [...new Set([...input, 'image'])] : input
                if (next.input.length === 1 && next.input[0] === 'text')
                    delete next.input
            }
            return next
        })
    }
    if (save.keyless && !entry.apiKey)
        entry.apiKey = KEYLESS_API_KEY
    else if (!save.keyless && entry.apiKey === KEYLESS_API_KEY)
        delete entry.apiKey
    // A built-in left with nothing overridden goes back to pi's defaults.
    if (Object.keys(entry).length)
        providers[endpoint.id] = entry
    else
        delete providers[endpoint.id]
    // pi's schema requires the key even when nothing is left in it.
    return { ...json, providers }
}

export function removeEndpoint(json: Record<string, any>, id: string): Record<string, any> {
    if (!isObject(json.providers) || !(id in json.providers))
        return json
    const providers = { ...json.providers }
    delete providers[id]
    // pi's schema requires the key even when nothing is left in it.
    return { ...json, providers }
}

/** models.json text ('' when missing) and its parsed object; refuses a file pi could not read either. */
export async function readModelsJson(): Promise<{ text: string, json: Record<string, any> }> {
    const text = await readFile(modelsJsonPath(), 'utf8').catch((error: any) => {
        if (error?.code === 'ENOENT')
            return ''
        throw error
    })
    if (!text.trim())
        return { text, json: {} }
    let json: unknown
    try {
        json = JSON.parse(text.replace(/^\uFEFF/, ''))
    }
    catch {
        throw new Error(tr('models.json 不是有效的 JSON，没有修改', 'models.json is not valid JSON; nothing was changed'))
    }
    if (!isObject(json))
        throw new Error(tr('models.json 不是一个对象，没有修改', 'models.json is not an object; nothing was changed'))
    return { text, json }
}

/** Atomic, and private like pi's own file: entries may hold keys. '' restores "no file" as an empty object. */
export async function writeModelsJson(content: Record<string, any> | string) {
    const file = modelsJsonPath()
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, file)
}

// ---------------------------------------------------------------- endpoint model list

/** `GET /models` of an endpoint (OpenAI and Anthropic shapes), for filling the model list. */
export async function fetchEndpointModels(fetcher: typeof fetch, baseUrl: string, api: string, apiKey: string | undefined): Promise<EndpointModel[]> {
    const base = baseUrl.trim().replace(/\/+$/, '')
    let url: URL
    try {
        url = new URL(base)
    }
    catch {
        throw new Error(tr('地址不是有效的 URL', 'The address is not a valid URL'))
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(tr('地址要以 http:// 或 https:// 开头', 'The address must start with http:// or https://'))
    const anthropic = api === 'anthropic-messages'
    // pi's Anthropic base URL has no /v1 (the SDK adds it); OpenAI-style ones include it.
    const target = anthropic && !base.endsWith('/v1') ? `${base}/v1/models` : `${base}/models`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey && apiKey !== KEYLESS_API_KEY) {
        headers.authorization = `Bearer ${apiKey}`
        if (anthropic)
            headers['x-api-key'] = apiKey
    }
    if (anthropic)
        headers['anthropic-version'] = '2023-06-01'
    const response = await fetcher(target, { headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok)
        throw new Error(`${target} → HTTP ${response.status}`)
    const body: any = await response.json().catch(() => null)
    const list: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
    const models: EndpointModel[] = []
    for (const item of list) {
        if (!isObject(item))
            continue
        const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : ''
        if (!id || models.some(m => m.id === id))
            continue
        const name = typeof item.display_name === 'string' && item.display_name !== id ? item.display_name : undefined
        models.push({ id, name })
    }
    if (!models.length)
        throw new Error(tr('端点没有列出模型，请手动填写', 'The endpoint listed no models; enter them by hand'))
    return models.slice(0, 500)
}


// ---------------------------------------------------------------- service

/**
 * What main's IPC handlers call. Every successful change ends with onChanged, so windows reload the
 * page and restart idle threads (pi reads auth.json and models.json only at startup).
 */
export class ProviderService {
    constructor(readonly helper: ProviderHelper, private onChanged: () => void, private fetcher: typeof fetch) {}

    async state(): Promise<ProvidersState> {
        const [list, models] = await Promise.all([
            this.helper.list(),
            readModelsJson().catch(() => ({ text: '', json: {} })),
        ])
        return { ...list, endpoints: readEndpoints(models.json) }
    }

    async logout(provider: string) {
        await this.helper.logout(provider)
        this.onChanged()
    }

    /** Writes the entry, has pi load it, and puts the file back if pi rejects it. */
    async saveEndpoint(save: EndpointSave) {
        const { providers } = await this.helper.list()
        const existing = providers.find(p => p.id === save.endpoint.id)
        if (save.create && existing)
            throw new Error(tr(`ID「${save.endpoint.id}」已被 ${existing.name} 使用`, `The ID "${save.endpoint.id}" is taken by ${existing.name}`))
        const builtIn = !!existing?.builtIn
        const before = await readModelsJson()
        const problem = checkEndpoint(save, builtIn, readEndpoints(before.json).find(e => e.id === save.endpoint.id)?.api)
        if (problem)
            throw new Error(problem)
        await writeModelsJson(applyEndpoint(before.json, save, builtIn))
        const { modelsError } = await this.helper.list()
        if (modelsError) {
            await this.restore(before.text)
            throw new Error(`${tr('pi 无法加载这个配置，没有保存：', 'pi could not load this setup, so it was not saved: ')}${modelsError}`)
        }
        if (save.apiKey)
            await this.helper.setKey(save.endpoint.id, save.apiKey)
        this.onChanged()
    }

    async removeEndpoint(id: string) {
        // A custom provider's saved key would have nothing left to sign in to; pi can only remove it
        // while the provider still exists.
        const { providers } = await this.helper.list()
        if (providers.some(p => p.id === id && !p.builtIn && p.stored))
            await this.helper.logout(id).catch(() => {})
        const before = await readModelsJson()
        await writeModelsJson(removeEndpoint(before.json, id))
        this.onChanged()
    }

    async endpointModels(baseUrl: string, api: string, apiKey: string | undefined, provider: string | undefined): Promise<EndpointModel[]> {
        const key = apiKey || (provider ? await this.helper.apiKey(provider).catch(() => null) : null) || undefined
        return fetchEndpointModels(this.fetcher, baseUrl, api, key)
    }

    private async restore(text: string) {
        if (text)
            await writeModelsJson(text)
        else
            await rm(modelsJsonPath(), { force: true })
    }
}
