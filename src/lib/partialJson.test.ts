import { describe, expect, it } from 'vitest'
import { parsePartialJson } from './partialJson'

describe('parsePartialJson', () => {
    it('closes an open string and object', () => {
        expect(parsePartialJson('{"command":"npm te')).toEqual({ command: 'npm te' })
    })

    it('drops a key that has no value yet', () => {
        expect(parsePartialJson('{"path":"a.ts","edits":')).toEqual({ path: 'a.ts' })
        expect(parsePartialJson('{"path":"a.ts",')).toEqual({ path: 'a.ts' })
    })

    it('closes nested arrays', () => {
        expect(parsePartialJson('{"edits":[{"oldText":"x"')).toEqual({ edits: [{ oldText: 'x' }] })
    })

    it('handles escapes at the cut point', () => {
        expect(parsePartialJson('{"command":"echo \\"hi')).toEqual({ command: 'echo "hi' })
    })

    it('returns undefined for empty input', () => {
        expect(parsePartialJson('')).toBeUndefined()
    })
})
