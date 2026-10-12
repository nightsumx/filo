import { describe, expect, it } from 'vitest'
import { fileMarks, markOf } from './fileMarks'

describe('fileMarks', () => {
    it('maps porcelain statuses', () => {
        expect(markOf(' M')).toBe('modified')
        expect(markOf('M ')).toBe('modified')
        expect(markOf('R ')).toBe('modified')
        expect(markOf('??')).toBe('added')
        expect(markOf('A ')).toBe('added')
        expect(markOf('UU')).toBe('conflict')
        expect(markOf('D ')).toBeNull()
    })

    it('marks files by absolute path and every folder above a change', () => {
        const marks = fileMarks('/repo', [{ path: 'src/a/x.ts', status: ' M' }, { path: 'new.md', status: '??' }, { path: 'gone/old.ts', status: 'D ' }])
        expect(Object.fromEntries(marks)).toEqual({
            '/repo/src/a/x.ts': 'modified',
            '/repo/src': 'modified',
            '/repo/src/a': 'modified',
            '/repo/new.md': 'added',
            '/repo/gone': 'modified',
        })
    })

    it('a folder keeps its own mark (an untracked folder) over the one from its contents', () => {
        const marks = fileMarks('C:\\repo', [{ path: 'docs/', status: '??' }, { path: 'docs/a.md', status: '??' }], '\\')
        expect(marks.get('C:\\repo\\docs')).toBe('added')
        expect(marks.get('C:\\repo\\docs\\a.md')).toBe('added')
    })
})
