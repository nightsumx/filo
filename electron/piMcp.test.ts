import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { piMcpAddArgs, piMcpRemoveArgs, piMcpServers, setPiMcp } from './piMcp'

describe('pi mcp', () => {
    let dir: string
    let project: string
    let saved: string | undefined
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-mcp-'))
        project = path.join(dir, 'proj')
        await mkdir(path.join(project, '.pi'), { recursive: true })
        saved = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = path.join(dir, 'agent')
        await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true })
    })
    afterEach(async () => {
        if (saved === undefined)
            delete process.env.PI_CODING_AGENT_DIR
        else
            process.env.PI_CODING_AGENT_DIR = saved
        await rm(dir, { recursive: true, force: true })
    })

    it('lists the project\'s servers and yours, and tells an override from a server', async () => {
        await writeFile(path.join(process.env.PI_CODING_AGENT_DIR!, 'mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'srv'], exposure: 'direct' }, docs: { url: 'https://d.example/mcp', enabled: false } } }))
        await writeFile(path.join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { docs: { enabled: true }, tools: { command: 'uvx', args: ['t'] } } }))
        expect(await piMcpServers(project)).toEqual([
            { name: 'docs', scope: 'project', transport: 'override', target: '', enabled: true, exposure: 'codemode' },
            { name: 'tools', scope: 'project', transport: 'stdio', target: 'uvx t', enabled: true, exposure: 'codemode' },
            { name: 'files', scope: 'user', transport: 'stdio', target: 'npx -y srv', enabled: true, exposure: 'direct' },
            { name: 'docs', scope: 'user', transport: 'http', target: 'https://d.example/mcp', enabled: false, exposure: 'codemode' },
        ])
    })

    it('switches a server off and sets its exposure, leaving the rest of the file as it was', async () => {
        const file = path.join(process.env.PI_CODING_AGENT_DIR!, 'mcp.json')
        await writeFile(file, JSON.stringify({ autoEnableCodemode: false, mcpServers: { files: { command: 'npx', env: { K: 'v' } }, other: { url: 'https://o.example/mcp' } } }))
        await setPiMcp(project, 'user', 'files', { enabled: false, exposure: 'deferred' })
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ autoEnableCodemode: false, mcpServers: { files: { command: 'npx', env: { K: 'v' }, enabled: false, exposure: 'deferred' }, other: { url: 'https://o.example/mcp' } } })
        await setPiMcp(project, 'user', 'files', { enabled: true, exposure: 'codemode' })
        expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.files).toEqual({ command: 'npx', env: { K: 'v' } })
    })

    it('refuses a server that is not in the file, and values pi does not take', async () => {
        await expect(setPiMcp(project, 'user', 'nope', { enabled: false })).rejects.toThrow()
        await writeFile(path.join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'x' } } }))
        await expect(setPiMcp(project, 'project', 'a', { exposure: 'everywhere' })).rejects.toThrow()
        await expect(setPiMcp(project, 'project', 'a', { enabled: 'no' })).rejects.toThrow()
        await expect(setPiMcp(project, 'both', 'a', { enabled: true })).rejects.toThrow()
        await expect(setPiMcp(project, 'user', '../a', { enabled: true })).rejects.toThrow()
    })

    it('builds pi mcp add: options before the --, the server\'s own arguments after', () => {
        expect(piMcpAddArgs({ cwd: '/p', name: 'files', scope: 'user', transport: 'stdio', target: 'npx -y srv "a b" --x', env: ['K=v=1'] }))
            .toEqual(['mcp', 'add', 'files', '--env', 'K=v=1', '--', 'npx', '-y', 'srv', 'a b', '--x'])
        expect(piMcpAddArgs({ cwd: '/p', name: 'docs', scope: 'project', transport: 'http', target: 'https://d.example/mcp' }))
            .toEqual(['mcp', 'add', '--local', 'docs', '--url', 'https://d.example/mcp'])
        expect(() => piMcpAddArgs({ cwd: '/p', name: '--url', scope: 'user', transport: 'stdio', target: 'x' })).toThrow()
        expect(() => piMcpAddArgs({ cwd: '/p', name: 'a', scope: 'user', transport: 'http', target: 'ftp://x' })).toThrow()
        expect(() => piMcpAddArgs({ cwd: '/p', name: 'a', scope: 'user', transport: 'stdio', target: ' ' })).toThrow()
        expect(() => piMcpAddArgs({ cwd: '/p', name: 'a', scope: 'user', transport: 'stdio', target: 'x', env: ['NOEQ'] })).toThrow()
        expect(() => piMcpAddArgs({ cwd: '/p', name: 'a', scope: 'team' as any, transport: 'stdio', target: 'x' })).toThrow()
    })

    it('builds pi mcp remove', () => {
        expect(piMcpRemoveArgs('user', 'files')).toEqual(['mcp', 'remove', 'files'])
        expect(piMcpRemoveArgs('project', 'files')).toEqual(['mcp', 'remove', '--local', 'files'])
        expect(() => piMcpRemoveArgs('user', '-x')).toThrow()
    })
})
