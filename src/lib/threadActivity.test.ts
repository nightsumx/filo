import type { Step } from './timeline'
import type { ActivityInput } from './threadActivity'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyLangPref } from './i18n'
import { formatElapsed, threadActivity } from './threadActivity'

beforeAll(() => {
    applyLangPref('zh')
})

const tool = (name: string, args: Record<string, unknown>): Step => ({ kind: 'tool', key: name, call: { type: 'toolCall', id: name, name, arguments: args } as any, running: true })
const base: ActivityInput = { running: false, starting: false, compacting: false, retry: null, agentError: '', steps: [], todo: null, cwd: '/p' }

describe('threadActivity', () => {
    it('describes the current tool call with the cwd stripped', () => {
        expect(threadActivity({ ...base, running: true, steps: [tool('bash', { command: 'npm test' })] }).text).toBe('运行 npm test')
        expect(threadActivity({ ...base, running: true, steps: [tool('edit', { path: '/p/src/a.ts' })] }).text).toBe('编辑 src/a.ts')
        expect(threadActivity({ ...base, running: true, steps: [] }).text).toBe('思考中')
        expect(threadActivity({ ...base, running: true, steps: [{ kind: 'text', key: 't', text: 'x', streaming: true }] }).text).toBe('回复中')
        applyLangPref('en')
        expect(threadActivity({ ...base, running: true, steps: [tool('bash', { command: 'npm test' })] }).text).toBe('Running npm test')
        applyLangPref('zh')
    })

    it('puts waiting first and reports open todo progress', () => {
        const todo = { kind: 'todo' as const, items: [{ text: 'a', status: 'done' as const }, { text: 'b', status: 'in_progress' as const }] }
        const a = threadActivity({ ...base, running: true, waitingFor: 'Which DB?\nmore', todo })
        expect(a).toEqual({ phase: 'waiting', text: '等你回答 · Which DB?', progress: { done: 1, total: 2 } })
        const allDone = { kind: 'todo' as const, items: [{ text: 'a', status: 'done' as const }] }
        expect(threadActivity({ ...base, running: true, todo: allDone }).progress).toBeUndefined()
    })

    it('flags failed runs but not user aborts', () => {
        expect(threadActivity({ ...base, steps: [{ kind: 'error', key: 'e', text: '429 rate limited', aborted: false }] })).toEqual({ phase: 'error', text: '429 rate limited' })
        expect(threadActivity({ ...base, steps: [{ kind: 'error', key: 'e', text: '', aborted: true }] }).phase).toBe('idle')
        expect(threadActivity({ ...base, agentError: 'spawn failed\nstack' }).text).toBe('spawn failed')
    })

    it('formats elapsed time as a clock', () => {
        expect(formatElapsed(42_000)).toBe('0:42')
        expect(formatElapsed(187_000)).toBe('3:07')
        expect(formatElapsed(3_723_000)).toBe('1:02:03')
    })
})
