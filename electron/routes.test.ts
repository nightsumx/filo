// RoutesService without agents: what it writes to the agents' config files and keeps in routes.json.
import type { RouteCatalog, RoutesConfig } from '@shared/routes'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BLOCK_END, BLOCK_START } from './gateway/agentConfig'
import { platform } from './platform'
import { RoutesService } from './routes'

const catalog: RouteCatalog = {
    models: [{ provider: 'p', providerName: 'P', id: 'm', name: 'M', api: 'openai-completions', contextWindow: 100_000, maxTokens: 8000 }],
    skipped: [],
}
const config: RoutesConfig = {
    groups: [{ id: 'g1', name: 'G', api: 'openai-completions', mode: 'order', members: [{ provider: 'p', model: 'm' }] }],
    syncTerminal: false,
    terminal: {},
}
const USER_TOML = 'model = "grok-4"\n\n[ui]\ntheme = "dark"\n'

let home: string
const env = () => ({ CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'), PI_CODING_AGENT_DIR: path.join(home, 'pi') })
const service = () => new RoutesService({
    env: env(),
    file: path.join(home, 'data', 'routes.json'),
    helper: { routeCatalog: async () => catalog, routeTarget: async () => ({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }) },
    onChanged: () => {},
    piExtension: '/x/routes.ts',
    home,
})
const grokToml = () => readFile(path.join(home, '.grok', 'config.toml'), 'utf8')

beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'routes-test-'))
    await mkdir(path.join(home, '.grok'))
    await writeFile(path.join(home, '.grok', 'config.toml'), USER_TOML)
})
afterEach(() => rm(home, { recursive: true, force: true }))

describe('routesService', () => {
    it('writes Grok\'s models while there are groups and leaves the user\'s file as it was on quit', async () => {
        const routes = service()
        await routes.save(config)
        const written = await grokToml()
        expect(written.startsWith(USER_TOML)).toBe(true)
        expect(written).toContain('[model."filo-g1"]')
        expect(written).toContain(`base_url = "http://127.0.0.1:${routes.state().status.port}/v1"`)
        expect(written).not.toMatch(/api_key/)
        await routes.shutdown()
        expect(await grokToml()).toBe(USER_TOML)
    })

    it('writes Grok\'s models to GROK_HOME when it is set', async () => {
        const grokHome = path.join(home, 'grok-elsewhere')
        await mkdir(grokHome)
        await writeFile(path.join(grokHome, 'config.toml'), USER_TOML)
        const routes = new RoutesService({ ...(service() as any).deps, env: { ...env(), GROK_HOME: grokHome } })
        await routes.save(config)
        expect(await readFile(path.join(grokHome, 'config.toml'), 'utf8')).toContain('[model."filo-g1"]')
        expect(await grokToml()).toBe(USER_TOML)
        await routes.shutdown()
        expect(await readFile(path.join(grokHome, 'config.toml'), 'utf8')).toBe(USER_TOML)
    })

    it('takes out a block a crashed run left behind, even with no groups left', async () => {
        const crashed = service()
        await crashed.save(config)
        expect(await grokToml()).toContain('filo-g1')
        await crashed.save({ ...config, groups: [] })
        // Its own block went with the change; put one back as a crash before that would have left it.
        const routes = service()
        await writeFile(path.join(home, '.grok', 'config.toml'), `${USER_TOML}${BLOCK_START}\n[model."filo-g1"]\nmodel = "g1"\n${BLOCK_END}\n`)
        await routes.init()
        expect(await grokToml()).toBe(USER_TOML)
        await Promise.all([crashed.shutdown(), routes.shutdown()])
    })

    it('lists the groups pi and Grok can pick, and nothing for the agents a thread puts on a group', async () => {
        const routes = service()
        await routes.save({ ...config, groups: [...config.groups, { id: 'e', name: 'Empty', api: 'openai-completions', mode: 'order', members: [] }] })
        expect(routes.state().launchKeys).toEqual({ grok: '[["g1","G","openai-completions"]]', pi: '[["g1","G","openai-completions"]]' })
        await routes.save({ ...config, groups: [] })
        expect(routes.state().launchKeys).toEqual({})
        await routes.shutdown()
    })

    it('starts an agent\'s process on its thread\'s group, and leaves it alone without one', async () => {
        const routes = service()
        const anthropic = { id: 'a', name: 'A', api: 'anthropic-messages' as const, mode: 'order' as const, members: [{ provider: 'p', model: 'm' }] }
        await routes.save({ ...config, groups: [...config.groups, anthropic] })
        const spec = { id: 'claude', label: 'Claude Code' } as any
        const launch = { command: 'claude', args: ['--x'], env: { ANTHROPIC_API_KEY: 'own', ANTHROPIC_AUTH_TOKEN: 'own' } } as any
        expect(await routes.routeAcp(spec, launch)).toBeUndefined()
        // A group of another API is not one Claude Code can be on.
        expect(await routes.routeAcp(spec, launch, { group: 'g1' })).toBeUndefined()
        const routed = await routes.routeAcp(spec, launch, { group: 'a', pin: 'p/m' })
        expect(routed!.launch.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${routes.state().status.port}`)
        expect(routed!.launch.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
        expect(routes.gateway.session(routed!.launch.env.ANTHROPIC_API_KEY!)).toMatchObject({ agent: 'claude', startGroup: 'a', override: { pin: 'p/m' } })
        // Grok lists every group: routed even without one, and on one it starts on its model.
        const grok = await routes.routeAcp({ id: 'grok', label: 'Grok' } as any, { command: 'grok', args: [], env: {} } as any, { group: 'g1' })
        expect(grok!.launch.args).toEqual(['-m', 'filo-g1'])
        expect(await routes.routeAcp({ id: 'grok', label: 'Grok' } as any, { command: 'grok', args: [], env: {} } as any)).toBeDefined()
        await routes.shutdown()
    })

    it('remembers the group a session is on across runs, for groups that still exist', async () => {
        const routes = service()
        await routes.save(config)
        await routes.setSessionGroup('/s/1.jsonl', 'g1')
        await routes.setSessionGroup('/s/2.jsonl', 'g1')
        await routes.setSessionGroup('/s/2.jsonl', undefined)
        await routes.shutdown()
        const next = service()
        await next.init()
        expect(next.sessionGroup('/s/1.jsonl')).toBe('g1')
        expect(next.sessionGroup('/s/2.jsonl')).toBeUndefined()
        await next.save({ ...config, groups: [] })
        expect(next.sessionGroup('/s/1.jsonl')).toBeUndefined()
        await next.shutdown()
    })

    it('writes a channel into Claude Code\'s and Codex\'s own config, keeps it after quit, and puts back what was there', async () => {
        const models: RouteCatalog['models'] = [
            { provider: 'p', providerName: 'P', id: 'glm', name: 'GLM', api: 'anthropic-messages' },
            { provider: 'p', providerName: 'P', id: 'claude-x', name: 'Claude X', api: 'anthropic-messages' },
            { provider: 'q', providerName: 'Q', id: 'r', name: 'R', api: 'openai-responses' },
        ]
        let key = 'k1'
        const deps = { ...(service() as any).deps, helper: {
            routeCatalog: async () => ({ models, skipped: [] }),
            routeTarget: async (provider: string) => ({ api: '', baseUrl: provider === 'p' ? 'https://p.test' : 'https://q.test/v1', apiKey: `${provider}-${key}` }),
        } }
        const claudeFile = path.join(home, 'claude', 'settings.json')
        const codexFile = path.join(home, 'codex', 'config.toml')
        const claudeText = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.test', FOO: '1' }, model: 'opus', theme: 'dark' }, null, 2)}\n`
        const codexText = 'model_provider = "mine" # my relay\nmodel = "gpt-5"\n\n[model_providers.mine]\nbase_url = "https://mine.test/v1"\n'
        await mkdir(path.dirname(claudeFile), { recursive: true })
        await mkdir(path.dirname(codexFile), { recursive: true })
        await writeFile(claudeFile, claudeText)
        await writeFile(codexFile, codexText)
        const routes = new RoutesService(deps)
        expect(await routes.channel('claude')).toEqual({ other: 'mine.test' })
        expect(await routes.channel('codex')).toEqual({ other: 'mine' })

        // A channel takes the place of terminal sync's group: the file names one endpoint.
        await routes.save({ ...config, groups: [...config.groups, { id: 'gc', name: 'GC', api: 'anthropic-messages', mode: 'order', members: [{ provider: 'p', model: 'glm' }] }], syncTerminal: true, terminal: { claude: 'gc' } })
        expect(await routes.channel('claude')).toEqual({ other: 'GC' })
        expect(await routes.useChannel('claude', { provider: 'p', model: 'glm' })).toEqual({ current: { provider: 'p', model: 'glm' }, restore: 'mine.test' })
        expect(routes.state().config.terminal).toEqual({})
        // Not a Claude model: every tier asks for it.
        expect(JSON.parse(await readFile(claudeFile, 'utf8'))).toEqual({
            env: { ANTHROPIC_BASE_URL: 'https://p.test', FOO: '1', ANTHROPIC_AUTH_TOKEN: 'p-k1', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm' },
            model: 'glm',
            theme: 'dark',
        })
        await routes.useChannel('claude', { provider: 'p', model: 'claude-x' })
        expect(JSON.parse(await readFile(claudeFile, 'utf8'))).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://p.test', FOO: '1', ANTHROPIC_AUTH_TOKEN: 'p-k1' }, model: 'claude-x', theme: 'dark' })
        await expect(routes.useChannel('claude', { provider: 'q', model: 'r' })).rejects.toThrow('Claude Code')

        await routes.useChannel('codex', { provider: 'q', model: 'r' })
        const table = '[model_providers."pi-q"]\nname = "Q"\nbase_url = "https://q.test/v1"\nwire_api = "responses"\nexperimental_bearer_token = '
        expect(await readFile(codexFile, 'utf8')).toBe(`model_provider = "pi-q"\nmodel = "r"\n\n[model_providers.mine]\nbase_url = "https://mine.test/v1"\n\n${table}"q-k1"\n`)
        // A new key in Providers: the copy in the config follows.
        key = 'k2'
        await routes.providersChanged()
        expect(await readFile(codexFile, 'utf8')).toContain(`${table}"q-k2"\n`)
        expect(JSON.parse(await readFile(claudeFile, 'utf8')).env.ANTHROPIC_AUTH_TOKEN).toBe('p-k2')

        // With warming, a thread on a channel goes through the gateway: Codex on the channel's own table.
        const warming = new RoutesService({ ...deps, warming: { mode: () => 'streaming', prices: () => ({}), warmed: () => {} } })
        const codex = await warming.routeAcp({ id: 'codex', label: 'Codex' } as any, { command: 'codex', args: [], env: {} } as any)
        const origin = `http://127.0.0.1:${warming.state().status.port}`
        expect(codex?.launch.args).toEqual(['-c', `model_providers.pi-q.base_url="${origin}/v1"`, '-c', 'model_providers.pi-q.env_key="FILO_GATEWAY_KEY"'])
        expect(warming.gateway.session(codex!.launch.env.FILO_GATEWAY_KEY!)?.channel).toEqual({ provider: 'q', model: 'r' })
        const claude = await warming.routeAcp({ id: 'claude', label: 'Claude Code' } as any, { command: 'claude', args: [], env: {} } as any)
        expect(claude?.launch.env.ANTHROPIC_BASE_URL).toBe(origin)
        expect(warming.gateway.session(claude!.launch.env.ANTHROPIC_API_KEY!)?.channel).toEqual({ provider: 'p', model: 'claude-x' })
        expect(await routes.routeAcp({ id: 'claude', label: 'Claude Code' } as any, { command: 'claude', args: [], env: {} } as any)).toBeUndefined()
        await warming.shutdown()

        // Quitting leaves the channels: a terminal keeps using them.
        await routes.shutdown()
        expect(await readFile(codexFile, 'utf8')).toContain('model_provider = "pi-q"')
        const next = new RoutesService(deps)
        expect(await next.channel('codex')).toEqual({ current: { provider: 'q', model: 'r' }, restore: 'mine' })
        expect(await next.useChannel('claude', null)).toEqual({ other: 'mine.test' })
        expect(await next.useChannel('codex', null)).toEqual({ other: 'mine' })
        expect(await readFile(claudeFile, 'utf8')).toBe(claudeText)
        // Its table stays: a session Codex ran on the channel resumes only with it.
        expect(await readFile(codexFile, 'utf8')).toBe(`${codexText}\n${table}"q-k2"\n`)
        await next.shutdown()
    })

    it('keeps routes.json private and the port for the next run', async () => {
        const routes = service()
        await routes.save(config)
        const port = routes.state().status.port
        await routes.shutdown()
        const file = path.join(home, 'data', 'routes.json')
        // Windows has no POSIX modes.
        if (platform.id !== 'win32')
            expect((await stat(file)).mode & 0o777).toBe(0o600)
        const saved = JSON.parse(await readFile(file, 'utf8'))
        expect(saved.port).toBe(port)
        expect(saved.config.groups[0].id).toBe('g1')
    })

    describe('terminal sync', () => {
        const claudeSettings = '{\n  "model": "opus",\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://relay.example"\n  }\n}\n'
        const codexConfig = 'model = "gpt-5"\nmodel_provider = "openai"\n\n[model_providers.openai]\nname = "OpenAI"\n'
        const synced: RoutesConfig = {
            groups: [
                { id: 'a', name: 'Anthropic', api: 'anthropic-messages', mode: 'order', members: [{ provider: 'p', model: 'm' }] },
                { id: 'r', name: 'Responses', api: 'openai-responses', mode: 'order', members: [{ provider: 'p', model: 'm' }] },
            ],
            syncTerminal: true,
            terminal: { claude: 'a', codex: 'r' },
        }
        const files = () => Promise.all([
            readFile(path.join(home, 'claude', 'settings.json'), 'utf8'),
            readFile(path.join(home, 'codex', 'config.toml'), 'utf8'),
            readFile(path.join(home, 'pi', 'models.json'), 'utf8').catch(() => undefined),
        ])
        beforeEach(async () => {
            await Promise.all(['claude', 'codex'].map(d => mkdir(path.join(home, d))))
            await writeFile(path.join(home, 'claude', 'settings.json'), claudeSettings)
            await writeFile(path.join(home, 'codex', 'config.toml'), codexConfig)
        })

        it('is off by default and touches nothing', async () => {
            const routes = service()
            await routes.save({ ...synced, syncTerminal: false })
            expect(await files()).toEqual([claudeSettings, codexConfig, undefined])
            await routes.shutdown()
        })

        it('points each agent\'s own config at the gateway with a key the gateway knows, and undoes it on quit', async () => {
            const routes = service()
            await routes.save(synced)
            const origin = `http://127.0.0.1:${routes.state().status.port}`
            const [claude, codex, pi] = await files()
            const env = JSON.parse(claude).env
            expect(env.ANTHROPIC_BASE_URL).toBe(origin)
            expect(routes.gateway.session(env.ANTHROPIC_AUTH_TOKEN)).toMatchObject({ agent: 'claude', startGroup: 'a' })
            expect(codex).toContain(`base_url = "${origin}/v1"`)
            const codexToken = /experimental_bearer_token = "([^"]+)"/.exec(codex)![1]
            expect(routes.gateway.session(codexToken)).toMatchObject({ agent: 'codex', startGroup: 'r' })
            const filo = JSON.parse(pi!).providers.filo
            expect(filo.models.map((m: any) => [m.id, m.baseUrl])).toEqual([['a', origin], ['r', `${origin}/v1`]])
            expect(routes.gateway.session(filo.apiKey)?.agent).toBe('pi')
            expect(routes.state().status.syncErrors).toEqual({})
            await routes.shutdown()
            // models.json did not exist before: it goes again.
            expect(await files()).toEqual([claudeSettings, codexConfig, undefined])
            expect(JSON.parse(await readFile(path.join(home, 'data', 'routes.json'), 'utf8')).terminal).toEqual({ files: {}, tokens: {} })
        })

        it('undoes a crashed run\'s edits on the next start once sync is off, keeping the user\'s later edits', async () => {
            const crashed = service()
            await crashed.save(synced)
            await crashed.gateway.close()
            // The user changed the model meanwhile, and turned sync off in this run's settings.
            const settings = JSON.parse((await files())[0])
            settings.model = 'sonnet'
            await writeFile(path.join(home, 'claude', 'settings.json'), JSON.stringify(settings, null, 2))
            const saved = JSON.parse(await readFile(path.join(home, 'data', 'routes.json'), 'utf8'))
            saved.config.syncTerminal = false
            await writeFile(path.join(home, 'data', 'routes.json'), JSON.stringify(saved))
            const routes = service()
            await routes.init()
            const [claude, codex, pi] = await files()
            expect(JSON.parse(claude)).toEqual({ model: 'sonnet', env: { ANTHROPIC_BASE_URL: 'https://relay.example' } })
            expect(codex).toBe(codexConfig)
            expect(pi).toBeUndefined()
            await routes.shutdown()
        })

        it('reports a file it cannot read as JSON and leaves it alone', async () => {
            await writeFile(path.join(home, 'claude', 'settings.json'), '{ "env": ')
            const routes = service()
            await routes.save(synced)
            expect(routes.state().status.syncErrors.claude).toMatch(/settings\.json/)
            expect((await files())[0]).toBe('{ "env": ')
            await routes.shutdown()
        })
    })
})
