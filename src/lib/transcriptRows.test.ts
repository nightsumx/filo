import type { Step, Turn } from './timeline'
import { describe, expect, it } from 'vitest'
import { transcriptRows } from './transcriptRows'

const tool = (key: string, name: string): Step => ({ kind: 'tool', key, call: { type: 'toolCall', id: key, name, arguments: {} } as any, running: false })
const text = (key: string, t: string): Step => ({ kind: 'text', key, text: t, streaming: false })
const turn = (key: string, steps: Step[], extra: Partial<Turn> = {}): Turn => ({
    key,
    user: { text: 'hi', images: [], timestamp: 0, pending: false },
    steps,
    startedAt: 0,
    endedAt: 5000,
    running: false,
    ...extra,
})

describe('transcriptRows', () => {
    it('folds a finished turn\'s process and keeps the answer visible', () => {
        const rows = transcriptRows([turn('a', [tool('a:0', 'read'), text('a:1', 'next'), tool('a:2', 'edit'), text('a:3', 'done')])])
        expect(rows.map(r => r.kind)).toEqual(['user', 'fold', 'item', 'footer'])
        expect(rows[1]).toMatchObject({ kind: 'fold', open: false })
        expect(rows[1].kind === 'fold' && rows[1].steps.map(s => s.key)).toEqual(['a:0', 'a:1', 'a:2'])
        expect(rows[2].kind === 'item' && rows[2].item.kind === 'step' && rows[2].item.step.key).toBe('a:3')
        expect(rows.at(-1)).toMatchObject({ kind: 'footer', finalText: 'done' })
    })

    it('gives every step its own row once a turn is unfolded', () => {
        const rows = transcriptRows([turn('a', [tool('a:0', 'read'), tool('a:1', 'bash'), tool('a:2', 'edit'), text('a:3', 'done')])], new Set(['a']))
        expect(rows.map(r => r.kind)).toEqual(['user', 'fold', 'item', 'item', 'item', 'footer'])
        expect(rows[1]).toMatchObject({ kind: 'fold', open: true })
        expect(rows[2].kind === 'item' && rows[2].item.kind).toBe('group')
    })

    it('marks the first row of each turn and adds a live row to the running last turn', () => {
        const rows = transcriptRows([
            turn('a', [text('a:0', 'x')]),
            turn('b', [tool('b:0', 'bash')], { user: undefined, running: true }),
        ])
        expect(rows.map(r => [r.kind, r.first])).toEqual([
            ['user', true],
            ['item', false],
            ['footer', false],
            ['item', true],
            ['live', false],
        ])
    })

    it('keeps row keys unique', () => {
        const rows = transcriptRows([turn('a', [text('a:0', 'x')]), turn('b', [text('b:0', 'y')])])
        expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
    })
})
