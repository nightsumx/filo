import { describe, expect, it } from 'vitest'
import { diffEntries, formatBytes, parseDelimited, previewOf } from './filePreview'

describe('previewOf', () => {
    it('maps extensions case-insensitively', () => {
        expect(previewOf('assets/Logo.PNG')).toEqual({ kind: 'image', mime: 'image/png' })
        expect(previewOf('icon.svg')?.kind).toBe('svg')
        expect(previewOf('docs/spec.pdf')?.kind).toBe('pdf')
        expect(previewOf('a/b.c/clip.webm')).toEqual({ kind: 'video', mime: 'video/webm' })
        expect(previewOf('sfx/hit.wav')?.kind).toBe('audio')
        expect(previewOf('fonts/Inter.woff2')?.kind).toBe('font')
        expect(previewOf('README.md')?.kind).toBe('markdown')
        expect(previewOf('data/rows.CSV')?.kind).toBe('csv')
        expect(previewOf('nb/eda.ipynb')?.kind).toBe('notebook')
        expect(previewOf('report.docx')?.kind).toBe('quicklook')
        expect(previewOf('photo.HEIC')?.kind).toBe('quicklook')
    })

    it('knows compressed tarballs by their double extension only', () => {
        expect(previewOf('dist/app.tar.gz')?.kind).toBe('archive')
        expect(previewOf('dist/app.tgz')?.kind).toBe('archive')
        expect(previewOf('lib.jar')?.kind).toBe('archive')
        expect(previewOf('log.gz')).toBeNull()
    })

    it('ignores text, dotfiles and names without an extension', () => {
        expect(previewOf('src/a.ts')).toBeNull()
        expect(previewOf('.png')).toBeNull()
        expect(previewOf('png')).toBeNull()
        expect(previewOf('dir.png/Makefile')).toBeNull()
        expect(previewOf('data.bin')).toBeNull()
    })
})

describe('formatBytes', () => {
    it('uses binary units', () => {
        expect(formatBytes(0)).toBe('0 B')
        expect(formatBytes(1023)).toBe('1023 B')
        expect(formatBytes(1024)).toBe('1 KB')
        expect(formatBytes(1536)).toBe('1.5 KB')
        expect(formatBytes(200 * 1024)).toBe('200 KB')
        expect(formatBytes(32 * 1024 * 1024)).toBe('32 MB')
    })
})

describe('parseDelimited', () => {
    it('handles quotes, doubled quotes, newlines in quotes, CRLF and a BOM', () => {
        const text = '\uFEFFname,note\r\n"Smith, J","said ""hi""\nthen left"\r\nx,\n'
        expect(parseDelimited(text, ',').rows).toEqual([
            ['name', 'note'],
            ['Smith, J', 'said "hi"\nthen left'],
            ['x', ''],
        ])
    })

    it('splits TSV and keeps a last row without a newline', () => {
        expect(parseDelimited('a\tb\n1\t2', '\t').rows).toEqual([['a', 'b'], ['1', '2']])
    })

    it('stops at the limit and says more rows follow', () => {
        expect(parseDelimited('1\n2\n3\n', ',', 2)).toEqual({ rows: [['1'], ['2']], more: true })
        expect(parseDelimited('1\n2\n', ',', 2)).toEqual({ rows: [['1'], ['2']], more: false })
    })
})

describe('diffEntries', () => {
    it('marks added and removed names when both sides exist', () => {
        expect(diffEntries(['b', 'a'], ['a', 'c'])).toEqual([
            { name: 'a', change: 'same' },
            { name: 'b', change: 'removed' },
            { name: 'c', change: 'added' },
        ])
    })

    it('marks nothing for a new or deleted archive', () => {
        expect(diffEntries(null, ['x']).map(e => e.change)).toEqual(['same'])
        expect(diffEntries(['x'], null).map(e => e.change)).toEqual(['same'])
    })
})
