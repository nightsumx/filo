import type { Step, Turn } from './timeline'
import type { TranscriptRow } from './transcriptRows'
import { describe, expect, it } from 'vitest'
import { estimateRow, markdownHeight } from './rowEstimate'

const turn = { key: 't', steps: [], startedAt: 0, endedAt: 0, running: false } as Turn
const item = (step: Step, first = false): TranscriptRow => ({ kind: 'item', key: step.key, turn, item: { kind: 'step', step }, first })
const WIDTH = 985

describe('markdownHeight', () => {
    it('wraps long lines and adds block gaps', () => {
        const one = markdownHeight('short line', 900)
        expect(one.lines).toBe(1)
        const para = 'word '.repeat(60).trim() // ~300 chars: 3 lines at 900px
        const two = markdownHeight(`${para}\n\n${para}`, 900)
        expect(two.lines).toBe(6)
        expect(two.height).toBeGreaterThan(6 * 22)
    })

    it('counts list items, table rows and code lines', () => {
        const md = '- a\n- b\n- c\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1\nconst b = 2\n```'
        const { height, lines } = markdownHeight(md, 900)
        expect(lines).toBe(3)
        // 3 list lines + 2 table rows + 2 code lines + 2 block gaps
        expect(height).toBeCloseTo(3 * 22.3 + 2 * 26 + 2 * 20 + 2 * 13.5, 0)
    })
})

describe('estimateRow', () => {
    it('caps thinking at the clipped five lines', () => {
        const long = { kind: 'thinking', key: 'k', text: 'thought '.repeat(400), streaming: false, redacted: false } as Step
        const short = { kind: 'thinking', key: 'k', text: 'one line', streaming: false, redacted: false } as Step
        expect(estimateRow(item(long), WIDTH)).toBe(177)
        expect(estimateRow(item(short), WIDTH)).toBe(58)
    })

    it('matches one-line tool rows and tool groups', () => {
        const tool = (id: string): Extract<Step, { kind: 'tool' }> => ({ kind: 'tool', key: id, call: { type: 'toolCall', id, name: 'bash', arguments: {} }, running: false })
        expect(estimateRow(item(tool('a')), WIDTH)).toBe(58)
        const group: TranscriptRow = { kind: 'item', key: 'g', turn, item: { kind: 'group', key: 'g', steps: [tool('a'), tool('b'), tool('c')] }, first: false }
        expect(estimateRow(group, WIDTH)).toBe(102)
    })

    it('grows text with its content', () => {
        const text = (t: string) => item({ kind: 'text', key: 'k', text: t, streaming: false })
        expect(estimateRow(text('ok'), WIDTH)).toBe(34)
        expect(estimateRow(text(Array.from({ length: 20 }, (_, i) => `- item ${i}`).join('\n')), WIDTH)).toBeGreaterThan(450)
    })
})
