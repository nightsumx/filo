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
    it('gives every step its own row and closes finished turns with a footer', () => {
        const rows = transcriptRows([turn('a', [tool('a:0', 'read'), tool('a:1', 'bash'), tool('a:2', 'edit'), text('a:3', 'done')])])
        expect(rows.map(r => r.kind)).toEqual(['user', 'item', 'item', 'item', 'footer'])
        expect(rows[1].kind === 'item' && rows[1].item.kind).toBe('group')
        expect(rows.at(-1)).toMatchObject({ kind: 'footer', finalText: 'done' })
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
