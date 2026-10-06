import { describe, expect, it } from 'vitest'
import { conflictsOf, editedBy } from './edits'

const files = {
    'a.ts': [{ session: '/s/two', title: 'two', at: 3 }, { session: '/s/one', title: 'one', at: 2 }],
    'b.ts': [{ session: '/s/one', title: 'one', at: 1 }],
    'c.ts': [{ session: '/s/two', title: 'two', at: 1 }],
}

describe('edits', () => {
    it('lists the files a session edited', () => {
        expect([...editedBy(files, '/s/one')]).toEqual(['a.ts', 'b.ts'])
        expect(editedBy(files, undefined).size).toBe(0)
    })

    it('reports a file as a conflict only when another session edited it too', () => {
        expect(conflictsOf(files, '/s/one')).toEqual([{ file: 'a.ts', others: [{ session: '/s/two', title: 'two', at: 3 }] }])
        expect(conflictsOf(files, '/s/three')).toEqual([])
    })
})
