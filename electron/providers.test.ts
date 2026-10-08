import type { LoginUpdate } from '@shared/providers'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyEndpoint, checkEndpoint, fetchEndpointModels, piEntry, ProviderHelper, ProviderService, readEndpoints, readModelsJson, removeEndpoint, writeModelsJson } from './providers'
import { platform } from './platform'

const root = path.resolve(__dirname, '..')
const PI_BIN = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')

describe('piEntry', () => {
    it('finds the SDK entry of the package a pi bin belongs to', () => {
        expect(piEntry(PI_BIN)).toBe(path.join(path.dirname(path.dirname(realpathSync(PI_BIN))), 'dist/index.js'))
    })

    it('gives up outside a pi package', () => {
        expect(piEntry(path.join(root, 'package.json'))).toBeUndefined()
        expect(piEntry('/nonexistent/pi')).toBeUndefined()
    })
})

describe('models.json endpoints', () => {
    const custom = {
        endpoint: { id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1/', api: 'openai-completions', models: [{ id: 'qwen3:8b', contextWindow: 32768 }] },
        keyless: true,
    }

    it('writes a custom provider and keeps every field it does not edit', () => {
        const before = {
            providers: {
                anthropic: { baseUrl: 'https://proxy.example', apiKey: '$PROXY_KEY' },
                local: { api: 'openai-completions', headers: { 'x-a': '1' }, models: [{ id: 'qwen3:8b', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, { id: 'gone' }] },
            },
            other: true,
        }
        expect(applyEndpoint(before, custom, false)).toEqual({
            providers: {
                anthropic: { baseUrl: 'https://proxy.example', apiKey: '$PROXY_KEY' },
                local: {
                    name: 'Local',
                    baseUrl: 'http://127.0.0.1:11434/v1',
                    api: 'openai-completions',
                    headers: { 'x-a': '1' },
                    apiKey: 'none',
                    models: [{ id: 'qwen3:8b', contextWindow: 32768, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
                },
            },
            other: true,
        })
        // The input object is not changed.
        expect(before.providers.local.models).toHaveLength(2)
    })

    it('changes only the address of a built-in, and drops the entry once nothing is overridden', () => {
        const proxy = applyEndpoint({}, { endpoint: { id: 'anthropic', baseUrl: 'https://proxy.example/' } }, true)
        expect(proxy).toEqual({ providers: { anthropic: { baseUrl: 'https://proxy.example' } } })
        expect(applyEndpoint(proxy, { endpoint: { id: 'anthropic', baseUrl: '' } }, true)).toEqual({ providers: {} })
        // A key in models.json survives an address change.
        expect(applyEndpoint({ providers: { anthropic: { apiKey: 'k' } } }, { endpoint: { id: 'anthropic', baseUrl: '' } }, true)).toEqual({ providers: { anthropic: { apiKey: 'k' } } })
    })

    it('marks image input and removes the keyless placeholder once a key is used', () => {
        const withImages = applyEndpoint({ providers: { local: { apiKey: 'none', models: [{ id: 'm', input: ['text'] }] } } }, {
            endpoint: { id: 'local', baseUrl: 'http://h', api: 'openai-completions', models: [{ id: 'm', images: true }] },
        }, false)
        expect(withImages.providers.local).toEqual({ baseUrl: 'http://h', api: 'openai-completions', models: [{ id: 'm', input: ['text', 'image'] }] })
        const textOnly = applyEndpoint(withImages, { endpoint: { id: 'local', baseUrl: 'http://h', api: 'openai-completions', models: [{ id: 'm', images: false }] } }, false)
        expect(textOnly.providers.local.models).toEqual([{ id: 'm' }])
    })

    it('reads entries back without key values, and removes one', () => {
        const json = applyEndpoint({ providers: { anthropic: { apiKey: 'secret' } } }, custom, false)
        const endpoints = readEndpoints(json)
        expect(endpoints).toEqual([
            { id: 'anthropic', name: undefined, baseUrl: undefined, api: undefined, models: undefined, hasKey: true, keyless: undefined },
            { id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', models: [{ id: 'qwen3:8b', name: undefined, contextWindow: 32768, maxTokens: undefined, reasoning: undefined, images: undefined }], hasKey: false, keyless: true },
        ])
        expect(JSON.stringify(endpoints)).not.toContain('secret')
        expect(removeEndpoint(json, 'local')).toEqual({ providers: { anthropic: { apiKey: 'secret' } } })
        expect(removeEndpoint({ providers: { local: {} } }, 'local')).toEqual({ providers: {} })
    })

    it('rejects what pi could not use', () => {
        const ok = { endpoint: { id: 'local', baseUrl: 'http://h/v1', api: 'openai-completions', models: [{ id: 'm' }] } }
        expect(checkEndpoint(ok, false)).toBeUndefined()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, id: 'a b' } }, false)).toBeTruthy()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, baseUrl: 'file:///etc' } }, false)).toBeTruthy()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, baseUrl: '' } }, false)).toBeTruthy()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, api: '' } }, false)).toBeTruthy()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, api: 'made-up' } }, false)).toBeTruthy()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, api: 'google-generative-ai' } }, false, 'google-generative-ai')).toBeUndefined()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, models: [] } }, false)).toBeTruthy()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, models: [{ id: 'm' }, { id: 'm ' }] } }, false)).toBeTruthy()
        expect(checkEndpoint({ endpoint: { ...ok.endpoint, models: [{ id: 'm', contextWindow: -5 }] } }, false)).toBeTruthy()
        // A built-in needs nothing but a valid (or empty) address.
        expect(checkEndpoint({ endpoint: { id: 'anthropic', baseUrl: '' } }, true)).toBeUndefined()
        expect(checkEndpoint({ endpoint: { id: 'anthropic', baseUrl: 'nope' } }, true)).toBeTruthy()
    })

    it('reads and writes PI_CODING_AGENT_DIR/models.json privately, refusing invalid JSON', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-models-'))
        const prev = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = dir
        try {
            expect(await readModelsJson()).toEqual({ text: '', json: {} })
            await writeModelsJson({ providers: { a: { apiKey: 'k' } } })
            const file = path.join(dir, 'models.json')
            // Windows has no mode bits: the user's profile folder is private by its ACL.
            if (platform.id !== 'win32')
                expect((await stat(file)).mode & 0o777).toBe(0o600)
            expect((await readModelsJson()).json).toEqual({ providers: { a: { apiKey: 'k' } } })
            await writeFile(file, '{ broken')
            await expect(readModelsJson()).rejects.toThrow()
        }
        finally {
            process.env.PI_CODING_AGENT_DIR = prev
            await rm(dir, { recursive: true, force: true })
        }
    })
})

describe('fetchEndpointModels', () => {
    const reply = (status: number, body: unknown, seen: { url?: string, headers?: Record<string, string> }): typeof fetch => async (url, init) => {
        seen.url = String(url)
        seen.headers = init?.headers as Record<string, string>
        return new Response(JSON.stringify(body), { status })
    }

    it('lists OpenAI-style models with a bearer key', async () => {
        const seen: { url?: string, headers?: Record<string, string> } = {}
        const models = await fetchEndpointModels(reply(200, { data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }, seen), 'http://h/v1/', 'openai-completions', 'k')
        expect(models).toEqual([{ id: 'a', name: undefined }, { id: 'b', name: undefined }])
        expect(seen.url).toBe('http://h/v1/models')
        expect(seen.headers?.authorization).toBe('Bearer k')
    })

    it('adds /v1 and Anthropic headers for Anthropic endpoints, and leaves the placeholder key out', async () => {
        const seen: { url?: string, headers?: Record<string, string> } = {}
        const models = await fetchEndpointModels(reply(200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] }, seen), 'https://proxy', 'anthropic-messages', 'none')
        expect(models).toEqual([{ id: 'claude-x', name: 'Claude X' }])
        expect(seen.url).toBe('https://proxy/v1/models')
        expect(seen.headers?.['anthropic-version']).toBeTruthy()
        expect(seen.headers?.authorization).toBeUndefined()
    })

    it('reports HTTP errors and empty lists', async () => {
        await expect(fetchEndpointModels(reply(401, {}, {}), 'http://h/v1', 'openai-completions', undefined)).rejects.toThrow('401')
        await expect(fetchEndpointModels(reply(200, { data: [] }, {}), 'http://h/v1', 'openai-completions', undefined)).rejects.toThrow()
        await expect(fetchEndpointModels(reply(200, {}, {}), 'ftp://h', 'openai-completions', undefined)).rejects.toThrow()
    })
})

// The real helper with the pi this repo builds against, in a throwaway agent dir.
describe('ProviderHelper', () => {
    let dir: string
    let helper: ProviderHelper
    const updates: LoginUpdate[] = []
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR

    beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-providers-'))
        // Main's own models.json reads and writes go to the same place.
        process.env.PI_CODING_AGENT_DIR = dir
        const env: Record<string, string> = { ...process.env as Record<string, string>, PI_CODING_AGENT_DIR: dir }
        // An ambient key would make the provider look configured before the test sets one.
        delete env.DEEPSEEK_API_KEY
        helper = new ProviderHelper(async () => ({
            node: process.execPath,
            script: path.join(root, 'electron/providerHelper.mts'),
            entry: piEntry(PI_BIN)!,
            env,
        }), update => updates.push(update))
    })

    afterAll(async () => {
        helper.stop()
        process.env.PI_CODING_AGENT_DIR = prevAgentDir
        await rm(dir, { recursive: true, force: true })
    })

    const waitFor = async (match: (u: LoginUpdate) => boolean) => {
        for (let i = 0; i < 200; i++) {
            const found = updates.find(match)
            if (found)
                return found
            await new Promise(r => setTimeout(r, 25))
        }
        throw new Error(`no update; got ${JSON.stringify(updates)}`)
    }

    it('lists pi\'s providers with their sign-in methods', async () => {
        const { providers, modelsError } = await helper.list()
        expect(modelsError).toBeUndefined()
        const deepseek = providers.find(p => p.id === 'deepseek')
        expect(deepseek).toMatchObject({ builtIn: true, configured: false, apiKey: { interactive: true }, available: 0 })
        expect(deepseek!.models).toBeGreaterThan(0)
        expect(providers.find(p => p.id === 'anthropic')?.oauth).toMatchObject({ subscription: true })
    }, 30_000)

    it('runs an API-key login through prompts and saves it to auth.json', async () => {
        const login = helper.login('deepseek', 'api_key')
        const prompt = await waitFor(u => u.login === login && 'prompt' in u)
        expect('prompt' in prompt && prompt.prompt.type).toBe('secret')
        helper.answer(login, 'promptId' in prompt ? prompt.promptId : '', 'sk-test')
        await waitFor(u => u.login === login && 'done' in u)
        expect(JSON.parse(await readFile(path.join(dir, 'auth.json'), 'utf8'))).toEqual({ deepseek: { type: 'api_key', key: 'sk-test' } })
        const deepseek = (await helper.list()).providers.find(p => p.id === 'deepseek')
        expect(deepseek).toMatchObject({ configured: true, source: 'stored', stored: 'api_key' })
        expect(deepseek!.available).toBeGreaterThan(0)
    }, 30_000)

    it('cancels a login waiting for an answer, without touching settings.json', async () => {
        const login = helper.login('anthropic', 'oauth')
        await waitFor(u => u.login === login && 'prompt' in u)
        helper.cancel(login)
        const end = await waitFor(u => u.login === login && 'error' in u)
        expect('cancelled' in end && end.cancelled).toBe(true)
        expect(existsSync(path.join(dir, 'settings.json'))).toBe(false)
    }, 30_000)

    it('saves a key directly and logs out', async () => {
        await helper.setKey('groq', 'gsk-test')
        expect((await helper.list()).providers.find(p => p.id === 'groq')).toMatchObject({ configured: true, stored: 'api_key' })
        await helper.logout('groq')
        expect((await helper.list()).providers.find(p => p.id === 'groq')).toMatchObject({ configured: false })
    }, 30_000)

    it('sees custom providers from models.json and reports a file pi rejects', async () => {
        await writeFile(path.join(dir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'none', models: [{ id: 'm1' }] } } }))
        const local = (await helper.list()).providers.find(p => p.id === 'local')
        expect(local).toMatchObject({ builtIn: false, configured: true, source: 'models_json_key', models: 1, available: 1 })
        await writeFile(path.join(dir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'm1' }] } } }))
        const broken = await helper.list()
        expect(broken.modelsError).toBeTruthy()
        expect(broken.providers.some(p => p.id === 'deepseek')).toBe(true)
    }, 30_000)

    it('saves an endpoint with its key, refuses taken ids, and puts models.json back when pi rejects it', async () => {
        await rm(path.join(dir, 'models.json'), { force: true })
        let changes = 0
        const service = new ProviderService(helper, () => changes++, fetch)
        await service.saveEndpoint({
            endpoint: { id: 'relay', name: 'Relay', baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', models: [{ id: 'gpt-x', contextWindow: 128000 }] },
            apiKey: 'rk-1',
            create: true,
        })
        expect(changes).toBe(1)
        const state = await service.state()
        expect(state.providers.find(p => p.id === 'relay')).toMatchObject({ name: 'Relay', builtIn: false, configured: true, stored: 'api_key', available: 1 })
        expect(state.endpoints.find(e => e.id === 'relay')).toMatchObject({ hasKey: false, models: [{ id: 'gpt-x', contextWindow: 128000 }] })
        expect(JSON.parse(await readFile(path.join(dir, 'auth.json'), 'utf8')).relay).toEqual({ type: 'api_key', key: 'rk-1' })

        await expect(service.saveEndpoint({ endpoint: { id: 'deepseek', baseUrl: 'http://h', api: 'openai-completions', models: [{ id: 'm' }] }, create: true })).rejects.toThrow('DeepSeek')
        // Another entry pi cannot load (no api): the save is refused and the file left as it was.
        const valid = JSON.parse(await readFile(path.join(dir, 'models.json'), 'utf8'))
        const before = JSON.stringify({ providers: { ...valid.providers, broken: { baseUrl: 'http://h', models: [{ id: 'm' }] } } })
        await writeFile(path.join(dir, 'models.json'), before)
        await expect(service.saveEndpoint({ endpoint: { id: 'relay', baseUrl: 'http://127.0.0.1:2/v1', api: 'openai-completions', models: [{ id: 'gpt-x' }] } })).rejects.toThrow()
        expect(await readFile(path.join(dir, 'models.json'), 'utf8')).toBe(before)
        expect(changes).toBe(1)
        await writeFile(path.join(dir, 'models.json'), JSON.stringify(valid))

        await service.removeEndpoint('relay')
        const after = await service.state()
        expect(after.providers.some(p => p.id === 'relay')).toBe(false)
        // The last entry gone, pi still loads the file.
        expect(after.modelsError).toBeUndefined()
        expect(JSON.parse(await readFile(path.join(dir, 'auth.json'), 'utf8')).relay).toBeUndefined()
    }, 30_000)
})
