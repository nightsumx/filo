import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeJsonPath, claudeMcpServers, commandWords, mcpAddArgs, mcpRemoveArgs } from './claudeSettings'

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
