import { describe, expect, it } from 'vitest'
import { detectEol, detectIndent, minimalChange, toLf } from './textEdit'

const apply = (text: string, c: ReturnType<typeof minimalChange>) => (c ? text.slice(0, c.from) + c.insert + text.slice(c.to) : text)

describe('minimalChange', () => {
    it('replaces only what lies between the common prefix and suffix', () => {
        expect(minimalChange('abc', 'abc')).toBeNull()
        expect(minimalChange('const a = 1\nconst b = 2\n', 'const a = 1\nconst b = 3\n')).toEqual({ from: 22, to: 23, insert: '3' })
        expect(minimalChange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' })
        expect(minimalChange('xyz', '')).toEqual({ from: 0, to: 3, insert: '' })
    })

    it('round-trips and keeps surrogate pairs whole', () => {
        const pairs: [string, string][] = [['a😀b', 'a😃b'], ['😀', '😀😀'], ['ab', 'ba'], ['', 'x'], ['😀x', '😃x']]
        for (const [a, b] of pairs) {
            const change = minimalChange(a, b)
            expect(apply(a, change)).toBe(b)
            if (change) {
                expect(a.charCodeAt(change.from) >= 0xDC00 && a.charCodeAt(change.from) <= 0xDFFF).toBe(false)
                expect(change.insert.charCodeAt(0) >= 0xDC00 && change.insert.charCodeAt(0) <= 0xDFFF).toBe(false)
            }
        }
    })
})

describe('line endings', () => {
    it('detects CRLF and normalizes to LF', () => {
        expect(detectEol('a\nb')).toBe('\n')
        expect(detectEol('a\r\nb')).toBe('\r\n')
        expect(toLf('a\r\nb\rc\n')).toBe('a\nb\nc\n')
    })
})

describe('detectIndent', () => {
    it('finds tabs, two and four spaces, ignores JSDoc continuations', () => {
        expect(detectIndent('a\n\tb\n\t\tc\n')).toBe('\t')
        expect(detectIndent('a {\n  b {\n    c\n  }\n}\n')).toBe('  ')
        expect(detectIndent('/**\n * doc\n */\nfunction f() {\n    return 1\n}\n')).toBe('    ')
        expect(detectIndent('no indent\n', '  ')).toBe('  ')
    })
})
