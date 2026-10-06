import type { AgentMessage } from '@shared/pi'
import type { TimelineMessage } from './timeline'
import { describe, expect, it } from 'vitest'
import { blockTimeKey, buildTurns, groupSteps } from './timeline'
import { readableError } from './utils'

let n = 0
const m = (message: AgentMessage): TimelineMessage => ({ key: `k${n++}`, message })
const user = (text: string, timestamp = 1000): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp })
const call = (id: string, name: string, args: object) => ({ type: 'toolCall' as const, id, name, arguments: args })

describe('buildTurns', () => {
    it('groups assistant blocks under the preceding user prompt and attaches tool results', () => {
        const turns = buildTurns([
            m(user('run tests')),
            m({ role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }, call('c1', 'bash', { command: 'npm test' })], stopReason: 'toolUse', timestamp: 2000 }),
            m({ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 5000 }),
            m({ role: 'assistant', content: [{ type: 'text', text: 'All green.' }], stopReason: 'stop', timestamp: 6000 }),
        ])
        expect(turns).toHaveLength(1)
        expect(turns[0].user?.text).toBe('run tests')
        expect(turns[0].steps.map(s => s.kind)).toEqual(['thinking', 'tool', 'text'])
        const tool = turns[0].steps[1]
        expect(tool.kind === 'tool' && tool.result?.content).toEqual([{ type: 'text', text: 'ok' }])
        expect(tool.kind === 'tool' && tool.running).toBe(false)
        expect(turns[0].endedAt - turns[0].startedAt).toBe(5000)
    })

    it('marks streaming blocks and live tool calls as running', () => {
        const turns = buildTurns([m(user('go'))], {
            running: true,
            streaming: { role: 'assistant', content: [{ type: 'text', text: 'Let me' }, call('c2', 'read', { path: 'a.ts' })], stopReason: 'pending', timestamp: 1 },
            tools: new Map([['c2', { running: true }]]),
        })
        const steps = turns[0].steps
        expect(steps[0]).toMatchObject({ kind: 'text', streaming: false })
        expect(steps[1]).toMatchObject({ kind: 'tool', running: true })
        expect(turns[0].running).toBe(true)
    })

    it('adds an error step for failed or aborted responses', () => {
        const turns = buildTurns([
            m(user('x')),
            m({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded', timestamp: 2 }),
        ])
        expect(turns[0].steps).toEqual([expect.objectContaining({ kind: 'error', text: '529 overloaded', aborted: false })])
    })

    it('renders compaction as its own turn and appends a pending prompt', () => {
        const turns = buildTurns(
            [m(user('a')), m({ role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: 3 })],
            { pendingPrompt: { text: 'next', images: [], timestamp: 4 } },
        )
        expect(turns.map(t => t.user?.text ?? t.steps[0]?.kind)).toEqual(['a', 'note', 'next'])
        expect(turns[2].user?.pending).toBe(true)
    })
})

describe('timing and usage', () => {
    const usage = (input: number, output: number, cacheRead: number, cost: number) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } })

    it('estimates block and tool timings from message start / end times', () => {
        const [turn] = buildTurns([
            m(user('go', 1000)),
            // 4 s message: thinking (300 chars) then a tool call whose arguments serialize to 100 chars.
            { ...m({ role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(300) }, call('c1', 'bash', { command: 'y'.repeat(86) })], stopReason: 'toolUse', timestamp: 2000 }), endedAt: 6000 },
            m({ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [], isError: false, timestamp: 8500 }),
            { ...m({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: 8501 }), endedAt: 9000 },
        ])
        const [thinking, tool] = turn.steps
        expect(thinking).toMatchObject({ kind: 'thinking', ms: 3000, endedAt: 5000 })
        expect(tool).toMatchObject({ kind: 'tool', startedAt: 6000, ms: 2500, endedAt: 8500 })
        // The turn ends when its last message was written, not when it started.
        expect(turn.endedAt).toBe(9000)
    })

    it('prefers block times recorded while streaming', () => {
        const [turn] = buildTurns([
            m(user('go', 1000)),
            { ...m({ role: 'assistant', content: [{ type: 'thinking', thinking: 'abc' }, { type: 'text', text: 'abc' }], stopReason: 'stop', timestamp: 2000 }), endedAt: 6000 },
        ], { blockTimes: new Map([[blockTimeKey(2000, 0), { start: 2500, end: 3200 }]]) })
        expect(turn.steps[0]).toMatchObject({ kind: 'thinking', ms: 700, endedAt: 3200 })
    })

    it('sums usage, models and thinking levels over a turn', () => {
        const [turn] = buildTurns([
            m(user('go')),
            m({ role: 'assistant', provider: 'anthropic', model: 'opus', thinkingLevel: 'high', usage: usage(100, 10, 900, 0.5), content: [call('c', 'ls', {})], stopReason: 'toolUse', timestamp: 2 }),
            m({ role: 'assistant', provider: 'anthropic', model: 'opus', thinkingLevel: 'high', usage: usage(50, 20, 950, 0.25), content: [{ type: 'text', text: 'x' }], stopReason: 'stop', timestamp: 3 }),
        ])
        expect(turn.usage).toMatchObject({ requests: 2, input: 150, output: 30, cacheRead: 1850, cost: 0.75, models: ['anthropic/opus'], thinkingLevels: ['high'] })
    })
})

describe('groupSteps', () => {
    it('groups runs of two or more read-only tools and keeps edits on their own', () => {
        const [turn] = buildTurns([
            m(user('q')),
            m({ role: 'assistant', content: [call('a', 'bash', {}), call('b', 'read', {}), call('c', 'edit', {}), call('d', 'bash', {})], stopReason: 'toolUse', timestamp: 2 }),
            m({ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: 3 }),
        ])
        const items = groupSteps(turn.steps)
        expect(items.map(i => (i.kind === 'group' ? `group×${i.steps.length}` : i.step.kind))).toEqual(['group×2', 'tool', 'tool', 'text'])
    })
})

describe('readableError', () => {
    it('extracts the message from a provider error body', () => {
        expect(readableError('{"id":"1791213519846-5jn9r8vxagf2r","type":"error","error":{"type":"internal_error","message":"服务器连接出错，请重试"}}')).toBe('服务器连接出错，请重试')
        expect(readableError('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe('529：Overloaded')
        expect(readableError('{"message":"bad key"}')).toBe('bad key')
    })

    it('leaves other text alone', () => {
        expect(readableError('fetch failed')).toBe('fetch failed')
        expect(readableError('Unexpected {token}')).toBe('Unexpected {token}')
        expect(readableError('{"foo":1}')).toBe('{"foo":1}')
    })
})
