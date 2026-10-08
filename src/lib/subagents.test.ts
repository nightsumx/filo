import type { SubagentDetails } from '@shared/capabilities'
import type { Step } from './timeline'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyLangPref } from './i18n'
import { childToolCallIds, childTurns, subagentActivity, subagentsIn } from './subagents'

beforeAll(() => {
    applyLangPref('zh')
})

const details = (over: Partial<SubagentDetails> = {}): SubagentDetails => ({
    kind: 'subagent',
    status: 'running',
    title: 'Scan',
    task: 'scan the repo',
    messages: [],
    tools: {},
    steering: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    startedAt: 1,
    ...over,
})

const call = (id: string, args: Record<string, unknown>, running: boolean, d?: SubagentDetails): Step => ({
    kind: 'tool',
    key: id,
    call: { type: 'toolCall', id, name: 'subagent', arguments: args } as any,
    running,
    result: d && { content: [], details: d, isError: false },
})

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as any
const assistant = (content: any[]) => ({ role: 'assistant', content, stopReason: 'toolUse', timestamp: 2 }) as any

describe('subagentsIn', () => {
    it('reads status from the call: starting, live, settled, and interrupted by a quit', () => {
        const steps: Step[] = [
            call('a', { title: 'A' }, true),
            call('b', {}, true, details({ title: 'B' })),
            call('c', {}, false, details({ title: 'C', status: 'done' })),
            call('d', { title: 'D' }, false),
            call('e', {}, false, details({ title: 'E' })),
            { kind: 'text', key: 't', text: 'x', streaming: false },
        ]
        expect(subagentsIn(steps).map(r => [r.id, r.title, r.status])).toEqual([
            ['a', 'A', 'starting'],
            ['b', 'B', 'running'],
            ['c', 'C', 'done'],
            ['d', 'D', 'interrupted'],
            ['e', 'E', 'interrupted'],
        ])
    })
})

describe('childTurns', () => {
    it('makes the task the first prompt and each steer its own turn, the streaming message last', () => {
        const d = details({
            messages: [user('scan the repo'), assistant([{ type: 'toolCall', id: 'k1', name: 'bash', arguments: { command: 'ls' } }]), user('only src/')],
            streaming: { role: 'assistant', content: [{ type: 'toolCall', id: 'k2', name: 'read', arguments: { path: '/p/src/a.ts' } }] } as any,
        })
        const turns = childTurns(d, true)
        expect(turns.map(t => t.user?.text)).toEqual(['scan the repo', 'only src/'])
        expect(turns[1].running).toBe(true)
        expect([...childToolCallIds(d)]).toEqual(['k1', 'k2'])
        const run = subagentsIn([call('x', {}, true, d)])[0]
        expect(subagentActivity(run, '/p')).toBe('读取 src/a.ts')
        expect(subagentActivity(subagentsIn([call('y', {}, true)])[0])).toBe('启动中')
    })
})
