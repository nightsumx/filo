import { describe, expect, it } from 'vitest'
import { parseNumstat, parsePorcelain } from './git'

describe('parsePorcelain', () => {
    it('parses modified, untracked and renamed entries', () => {
        const out = [' M src/a.ts', '?? new file.txt', 'R  b-new.ts', 'b-old.ts', ''].join('\0')
        expect(parsePorcelain(out)).toEqual([
            { path: 'src/a.ts', status: ' M' },
            { path: 'new file.txt', status: '??' },
            { path: 'b-new.ts', status: 'R ' },
        ])
    })
})

describe('parseNumstat', () => {
    it('reads counts, binary files and renames', () => {
        const out = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.ts', 'new.ts', ''].join('\0')
        const stats = parseNumstat(out)
        expect(stats.get('src/a.ts')).toEqual({ additions: 3, deletions: 1, binary: false })
        expect(stats.get('img.png')).toEqual({ additions: 0, deletions: 0, binary: true })
        expect(stats.get('new.ts')).toEqual({ additions: 2, deletions: 0, binary: false })
    })
})
