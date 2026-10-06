import type { Step } from './timeline'
import { describe, expect, it } from 'vitest'
import { splitTurn, turnStats } from './turnSummary'

const tool = (key: string, name: string, args: Record<string, unknown> = {}, result?: Partial<Extract<Step, { kind: 'tool' }>['result']>): Step => ({
    kind: 'tool',
    key,
    call: { type: 'toolCall', id: key, name, arguments: args } as any,
    result: result ? { content: [], isError: false, ...result } : undefined,
    running: false,
})
const text = (key: string, t: string): Step => ({ kind: 'text', key, text: t, streaming: false })

describe('splitTurn', () => {
    it('splits after the last tool or thinking step', () => {
        const steps = [tool('0', 'read'), text('1', 'a'), tool('2', 'bash'), text('3', 'b'), text('4', 'c')]
        const { process, tail } = splitTurn(steps)
        expect(process.map(s => s.key)).toEqual(['0', '1', '2'])
        expect(tail.map(s => s.key)).toEqual(['3', '4'])
    })

    it('has no process for a plain answer', () => {
        expect(splitTurn([text('0', 'a')]).process).toEqual([])
    })
})

describe('turnStats', () => {
    it('counts commands, distinct files and diff lines', () => {
        const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n+more\n'
        const s = turnStats([
            tool('0', 'bash', { command: 'ls' }),
            tool('1', 'bash', { command: 'pwd' }),
            tool('2', 'read', { path: 'a.ts' }),
            tool('3', 'read', { path: 'a.ts' }),
            tool('4', 'grep', { pattern: 'x' }),
            tool('5', 'edit', { path: 'x.ts' }, { details: { patch } }),
            tool('6', 'write', { path: 'y.ts', content: 'a\nb\n' }, {}),
            tool('7', 'edit', { path: 'x.ts' }, { isError: true }),
            tool('8', 'todo'),
        ])
        expect(s).toMatchObject({ commands: 2, reads: 1, searches: 1, edited: 2, added: 4, removed: 1, other: 1, failed: 1 })
    })

    it('sums thinking time and finds when the last step finished', () => {
        const thinking = (key: string, ms: number, endedAt: number): Step => ({ kind: 'thinking', key, text: 't', streaming: false, redacted: false, ms, endedAt })
        const s = turnStats([thinking('0', 1200, 3000), { ...tool('1', 'bash'), endedAt: 9000 } as Step, thinking('2', 800, 9800)])
        expect(s).toMatchObject({ thinking: true, thinkingMs: 2000, endedAt: 9800 })
    })
})
