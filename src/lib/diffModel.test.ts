import { createTwoFilesPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { diffFromContent, diffFromEdits, diffFromPatch, splitRows, unifiedRows } from './diffModel'

const before = ['a', 'b', 'const x = 1', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'old tail', 'k'].join('\n')
const after = ['a', 'b', 'const x = 2', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n')

describe('diffFromPatch', () => {
    it('keeps real file line numbers and counts', () => {
        const model = diffFromPatch(createTwoFilesPatch('f.ts', 'f.ts', before, after, '', '', { context: 1 }))!
        expect(model.added).toBe(1)
        expect(model.removed).toBe(2)
        expect(model.hunks).toHaveLength(2)
        const del = model.hunks[0].find(l => l.kind === 'del')!
        expect(del).toMatchObject({ oldNo: 3, text: 'const x = 1' })
        expect(model.hunks[1].find(l => l.kind === 'del')).toMatchObject({ oldNo: 12, text: 'old tail' })
    })

    it('marks only the changed word of a paired line', () => {
        const model = diffFromPatch(createTwoFilesPatch('f.ts', 'f.ts', before, after, '', '', { context: 0 }))!
        const [del, add] = model.hunks[0]
        expect(del.marks).toEqual([[10, 11]])
        expect(add.marks).toEqual([[10, 11]])
    })

    it('returns null for text that is not a patch', () => {
        expect(diffFromPatch('nothing here')).toBeNull()
    })
})

describe('layout', () => {
    it('pairs removed and added lines side by side and separates hunks', () => {
        const model = diffFromPatch(createTwoFilesPatch('f.ts', 'f.ts', before, after, '', '', { context: 0 }))!
        const rows = splitRows(model)
        expect(rows).toHaveLength(3)
        expect(rows[0]).toMatchObject({ left: { text: 'const x = 1' }, right: { text: 'const x = 2' } })
        expect(rows[1]).toEqual({ gap: true })
        expect(rows[2]).toMatchObject({ left: { text: 'old tail' }, right: undefined })
        expect(unifiedRows(model)).toHaveLength(4)
    })

    it('builds diffs from edit arguments and written content', () => {
        expect(diffFromEdits([{ oldText: 'x\ny', newText: 'x\nz' }])).toMatchObject({ added: 1, removed: 1 })
        const write = diffFromContent('one\ntwo\n')
        expect(write.added).toBe(2)
        expect(write.hunks[0].map(l => l.newNo)).toEqual([1, 2])
    })
})
