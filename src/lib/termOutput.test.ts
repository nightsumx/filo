import { describe, expect, it } from 'vitest'
import { displayText, headCount, isBlockArt, segmentOutput, tailLines } from './termOutput'

const qr = ['█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█', '█ ███ █ ▀█▀ █ ███ █', '▀▀▀▀▀▀▀ ▀ ▀ ▀▀▀▀▀▀▀']

describe('termOutput', () => {
    it('drops ANSI escapes and carriage returns like pi\'s TUI', () => {
        expect(displayText('\x1B[93mPlease use `x login`\x1B[0m\r\n\x1B]0;title\x07done')).toBe('Please use `x login`\ndone')
    })

    it('recognizes QR rows but not prose or box drawing', () => {
        expect(qr.every(isBlockArt)).toBe(true)
        expect(isBlockArt('  ▄▄  ')).toBe(true)
        expect(isBlockArt('█ done')).toBe(false)
        expect(isBlockArt('└──┘')).toBe(false)
        expect(isBlockArt('')).toBe(false)
    })

    it('keeps the last five lines, or the whole QR code they cut into', () => {
        const plain = Array.from({ length: 9 }, (_, i) => `line ${i}`)
        expect(tailLines(plain.join('\n'))).toEqual(plain.slice(-5))
        const out = ['start', ...qr, ...qr, 'Scan this QR', 'hint', 'waiting', '']
        expect(tailLines(out.join('\n'))).toEqual(out.slice(1, -1))
        // A QR code scrolled out of the last five lines stays out.
        expect(tailLines([...qr, ...plain].join('\n'))).toEqual(plain.slice(-5))
        expect(tailLines('')).toEqual([])
    })

    it('groups lines into text and art', () => {
        expect(segmentOutput(['a', ...qr, 'b', ''])).toEqual([
            { art: false, lines: ['a'] },
            { art: true, lines: qr },
            { art: false, lines: ['b', ''] },
        ])
    })

    it('lets a preview run past its cut to finish a QR code', () => {
        const art = Array.from({ length: 12 }, () => qr[0])
        expect(headCount(['a', ...art, 'b'], 10)).toBe(13)
        expect(headCount(Array.from({ length: 20 }, (_, i) => `l${i}`), 10)).toBe(10)
        // The cut falls right before the art, or the output is short: nothing to extend.
        expect(headCount([...Array.from({ length: 10 }, () => 'x'), ...art], 10)).toBe(10)
        expect(headCount(['a', 'b'], 10)).toBe(2)
    })
})
