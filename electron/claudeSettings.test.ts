import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeJsonPath, claudeMcpServers, claudeMemory, codexMcpTable, codexPluginChange, commandLine, codexServerName, commandWords, mcpAddArgs, mcpRemoveArgs, setClaudeAutoMemory } from './claudeSettings'
import { projectSlug } from './native/claudeTui'

describe('commandWords', () => {
    it('splits on spaces and keeps quoted words whole', () => {
        expect(commandWords('npx -y @scope/server --dir "my files" \'a b\'')).toEqual(['npx', '-y', '@scope/server', '--dir', 'my files', 'a b'])
    })
    it('lets a backslash escape a space, and keeps an empty quoted word', () => {
        expect(commandWords('run a\\ b ""')).toEqual(['run', 'a b', ''])
    })
    it('refuses an unclosed quote', () => {
        expect(() => commandWords('run "oops')).toThrow()
    })
})

describe('mcpAddArgs', () => {
    const base = { cwd: '/p', name: 'files', scope: 'user' as const }
    it('puts the name first, then -e values, then -- and the command', () => {
        expect(mcpAddArgs({ ...base, transport: 'stdio', target: 'npx -y server "a b"', env: ['KEY=v=1'] }))
            .toEqual(['mcp', 'add', '-s', 'user', 'files', '-e', 'KEY=v=1', '--', 'npx', '-y', 'server', 'a b'])
    })
    it('adds a remote server by transport and URL', () => {
        expect(mcpAddArgs({ ...base, transport: 'http', target: 'https://example.com/mcp' }))
            .toEqual(['mcp', 'add', '-s', 'user', '--transport', 'http', 'files', 'https://example.com/mcp'])
    })
    it('refuses what would not be one argument or option', () => {
        expect(() => mcpAddArgs({ ...base, name: '--scope', transport: 'stdio', target: 'x' })).toThrow()
        expect(() => mcpAddArgs({ ...base, name: 'a b', transport: 'stdio', target: 'x' })).toThrow()
        expect(() => mcpAddArgs({ ...base, transport: 'http', target: 'file:///etc/passwd' })).toThrow()
        expect(() => mcpAddArgs({ ...base, transport: 'stdio', target: '  ' })).toThrow()
        expect(() => mcpAddArgs({ ...base, transport: 'stdio', target: 'x', env: ['NOEQUALS'] })).toThrow()
        expect(() => mcpAddArgs({ ...base, scope: 'all' as any, transport: 'stdio', target: 'x' })).toThrow()
    })
})

describe('mcpRemoveArgs', () => {
    it('removes by scope and name', () => {
        expect(mcpRemoveArgs({ cwd: '/p', name: 'files', scope: 'local' })).toEqual(['mcp', 'remove', '-s', 'local', 'files'])
        expect(() => mcpRemoveArgs({ cwd: '/p', name: '-x', scope: 'local' })).toThrow()
    })
})

describe('claudeMcpServers', () => {
    let dir: string
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'claude-mcp-'))
    })
    afterEach(() => rm(dir, { recursive: true, force: true }))

    it('puts .claude.json inside CLAUDE_CONFIG_DIR when it is set, else in the home folder', () => {
        expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: '/c' }, '/h')).toBe('/c/.claude.json')
        expect(claudeJsonPath({}, '/h')).toBe('/h/.claude.json')
    })

    it('lists the project\'s own, the team\'s .mcp.json and the user\'s servers', async () => {
        const project = path.join(dir, 'proj')
        await mkdir(project, { recursive: true })
        await writeFile(path.join(dir, '.claude.json'), JSON.stringify({
            mcpServers: { everywhere: { type: 'http', url: 'https://u.example/mcp' } },
            projects: { [project]: { mcpServers: { mine: { command: 'node', args: ['a.js', 'b'] } } }, '/other': { mcpServers: { nope: { command: 'x' } } } },
        }))
        await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { team: { command: 'npx', args: ['-y', 'srv'] } } }))
        expect(await claudeMcpServers(project, { CLAUDE_CONFIG_DIR: dir }, '/nowhere')).toEqual([
            { name: 'mine', scope: 'local', transport: 'stdio', target: 'node a.js b' },
            { name: 'team', scope: 'project', transport: 'stdio', target: 'npx -y srv' },
            { name: 'everywhere', scope: 'user', transport: 'http', target: 'https://u.example/mcp' },
        ])
    })

    it('is empty without any file', async () => {
        expect(await claudeMcpServers(path.join(dir, 'p'), { CLAUDE_CONFIG_DIR: dir }, '/nowhere')).toEqual([])
    })
})

describe('claude memory', () => {
    let dir: string
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'claude-mem-'))
    })
    afterEach(() => rm(dir, { recursive: true, force: true }))

    it('is on unless settings.json says false, and finds the files that exist', async () => {
        const cwd = path.join(dir, 'proj')
        const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') }
        await mkdir(cwd, { recursive: true })
        expect(await claudeMemory(cwd, env)).toEqual({ enabled: true, userFolder: env.CLAUDE_CONFIG_DIR, userFile: undefined, projectFile: undefined, dir: undefined })
        const notes = path.join(env.CLAUDE_CONFIG_DIR, 'projects', projectSlug(cwd), 'memory')
        await mkdir(notes, { recursive: true })
        await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), 'mine')
        await writeFile(path.join(cwd, 'CLAUDE.md'), 'ours')
        await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }))
        expect(await claudeMemory(cwd, env)).toMatchObject({ enabled: false, userFile: path.join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), projectFile: path.join(cwd, 'CLAUDE.md'), dir: notes })
    })

    it('writes the switch and keeps every other key', async () => {
        const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') }
        await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
        await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { a: 1 } }))
        await setClaudeAutoMemory(false, env)
        expect(JSON.parse(await readFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'))).toEqual({ model: 'opus', hooks: { a: 1 }, autoMemoryEnabled: false })
        await setClaudeAutoMemory(true, env)
        expect((await claudeMemory(dir, env)).enabled).toBe(true)
        await expect(setClaudeAutoMemory('no', env)).rejects.toThrow()
    })
})

describe('codexMcpTable', () => {
    it('makes the config.toml table of a command server, with its environment', () => {
        expect(codexMcpTable({ name: 'files', transport: 'stdio', target: 'npx -y srv "a b"', env: ['K=v=1'] }))
            .toEqual({ command: 'npx', args: ['-y', 'srv', 'a b'], env: { K: 'v=1' } })
        expect(codexMcpTable({ name: 'files', transport: 'stdio', target: 'node' })).toEqual({ command: 'node', args: [] })
    })
    it('makes the table of a URL server', () => {
        expect(codexMcpTable({ name: 'web', transport: 'http', target: 'https://example.com/mcp' })).toEqual({ url: 'https://example.com/mcp' })
    })
    it('refuses a name that would reach into other keys, and what is no command or URL', () => {
        for (const name of ['a.b', 'a b', '', '-x', 'x]\n[y'])
            expect(() => codexMcpTable({ name, transport: 'stdio', target: 'x' }), name).toThrow()
        expect(() => codexMcpTable({ name: 'ok', transport: 'http', target: 'ftp://x' })).toThrow()
        expect(() => codexMcpTable({ name: 'ok', transport: 'stdio', target: ' ' })).toThrow()
        expect(() => codexMcpTable({ name: 'ok', transport: 'stdio', target: 'x', env: ['NOEQUALS'] })).toThrow()
        expect(() => codexMcpTable({ name: 'ok', transport: 'sse', target: 'x' })).toThrow()
        expect(() => codexServerName('a.b')).toThrow()
        expect(codexServerName('a-b_12')).toBe('a-b_12')
    })
})

describe('codexPluginChange', () => {
    it('takes the changes the page makes', () => {
        expect(codexPluginChange({ action: 'install', marketplacePath: '/m/.agents/plugins/marketplace.json', name: 'hello' })).toEqual({ action: 'install', marketplacePath: '/m/.agents/plugins/marketplace.json', name: 'hello' })
        expect(codexPluginChange({ action: 'uninstall', id: 'hello@local' })).toEqual({ action: 'uninstall', id: 'hello@local' })
        expect(codexPluginChange({ action: 'enable', id: 'hello@local-test', enabled: false })).toEqual({ action: 'enable', id: 'hello@local-test', enabled: false })
        expect(codexPluginChange({ action: 'addMarketplace', source: ' owner/repo ' })).toEqual({ action: 'addMarketplace', source: 'owner/repo' })
        expect(codexPluginChange({ action: 'removeMarketplace', name: 'local-test' })).toEqual({ action: 'removeMarketplace', name: 'local-test' })
    })
    it('refuses the rest, and an id that would reach into other config keys', () => {
        for (const bad of [null, 'install', { action: 'format' }, { action: 'install', marketplacePath: 'relative.json', name: 'x' }, { action: 'install', marketplacePath: '/m', name: '' },
            { action: 'enable', id: 'a.b@c', enabled: true }, { action: 'enable', id: 'a@c', enabled: 'yes' }, { action: 'enable', id: 'a@b.c', enabled: true },
            { action: 'addMarketplace', source: '  ' }, { action: 'uninstall' }])
            expect(() => codexPluginChange(bad), JSON.stringify(bad)).toThrow()
    })
})

describe('commandLine', () => {
    it('quotes only the words that need it, and reads back as the same words', () => {
        const words = ['node', '-e', 'console.log("hi there")', 'a b', "it's", 'back\\slash', '', 'plain']
        expect(commandLine(['node', '-e', 'x', 'a', 'b'])).toBe('node -e x a b')
        expect(commandLine(['say', 'hello world'])).toBe('say "hello world"')
        expect(commandWords(commandLine(words))).toEqual(words)
    })
})
