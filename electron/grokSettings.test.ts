import { describe, expect, it } from 'vitest'
import { grokMcpAddArgs, grokMcpEnableArgs, grokMcpRemoveArgs, parseGrokMcp } from './grokSettings'

describe('parseGrokMcp', () => {
    it('reads what `grok mcp list --json` prints', () => {
        const output = JSON.stringify([
            { command: 'node', args: ['-e', '1', 'a b'], env: { K: 'v' }, enabled: true, name: 'files', scope: 'user' },
            { url: 'https://example.com/mcp', enabled: false, name: 'web', scope: 'project' },
            { url: 'https://x.example/sse', type: 'sse', enabled: true, name: 'old', scope: 'user' },
        ])
        expect(parseGrokMcp(output)).toEqual([
            { name: 'files', scope: 'user', transport: 'stdio', target: 'node -e 1 a b', enabled: true },
            { name: 'web', scope: 'project', transport: 'http', target: 'https://example.com/mcp', enabled: false },
            { name: 'old', scope: 'user', transport: 'sse', target: 'https://x.example/sse', enabled: true },
        ])
    })
    it('is empty for output that is no list', () => {
        expect(parseGrokMcp('')).toEqual([])
        expect(parseGrokMcp('No MCP servers')).toEqual([])
        expect(parseGrokMcp('{"a":1}')).toEqual([])
        expect(parseGrokMcp('[1,{"x":1}]')).toEqual([])
    })
})

describe('grok mcp arguments', () => {
    const base = { cwd: '/p', name: 'files', scope: 'user' as const }
    it('puts options first and the server\'s own command after --', () => {
        expect(grokMcpAddArgs({ ...base, transport: 'stdio', target: 'npx -y srv "a b"', env: ['K=v=1'] }))
            .toEqual(['mcp', 'add', '-s', 'user', '-e', 'K=v=1', 'files', '--', 'npx', '-y', 'srv', 'a b'])
        expect(grokMcpAddArgs({ ...base, scope: 'project', transport: 'sse', target: 'https://x.example/sse' }))
            .toEqual(['mcp', 'add', '-s', 'project', '-t', 'sse', 'files', 'https://x.example/sse'])
    })
    it('refuses what would be read as an option or is no command or URL', () => {
        expect(() => grokMcpAddArgs({ ...base, name: '--scope', transport: 'stdio', target: 'x' })).toThrow()
        expect(() => grokMcpAddArgs({ ...base, transport: 'http', target: 'file:///etc/passwd' })).toThrow()
        expect(() => grokMcpAddArgs({ ...base, transport: 'stdio', target: ' ' })).toThrow()
        expect(() => grokMcpAddArgs({ ...base, transport: 'stdio', target: 'x', env: ['NOEQ'] })).toThrow()
        expect(() => grokMcpAddArgs({ ...base, scope: 'team' as any, transport: 'stdio', target: 'x' })).toThrow()
        expect(() => grokMcpAddArgs({ ...base, transport: 'websocket' as any, target: 'x' })).toThrow()
    })
    it('removes by scope and enables by name', () => {
        expect(grokMcpRemoveArgs('project', 'files')).toEqual(['mcp', 'remove', '-s', 'project', 'files'])
        expect(() => grokMcpRemoveArgs('user', '-x')).toThrow()
        expect(grokMcpEnableArgs('files', false)).toEqual(['mcp', 'disable', 'files'])
        expect(grokMcpEnableArgs('files', true)).toEqual(['mcp', 'enable', 'files'])
        expect(() => grokMcpEnableArgs('files', 'yes')).toThrow()
    })
})
