import { describe, expect, it } from 'vitest'
import { formatBytes, previewOf } from './filePreview'

describe('previewOf', () => {
    it('maps extensions case-insensitively', () => {
        expect(previewOf('assets/Logo.PNG')).toEqual({ kind: 'image', mime: 'image/png' })
        expect(previewOf('icon.svg')?.kind).toBe('svg')
        expect(previewOf('docs/spec.pdf')?.kind).toBe('pdf')
        expect(previewOf('a/b.c/clip.webm')).toEqual({ kind: 'video', mime: 'video/webm' })
        expect(previewOf('sfx/hit.wav')?.kind).toBe('audio')
    })

    it('ignores text, dotfiles and names without an extension', () => {
        expect(previewOf('src/a.ts')).toBeNull()
        expect(previewOf('.png')).toBeNull()
        expect(previewOf('png')).toBeNull()
        expect(previewOf('dir.png/Makefile')).toBeNull()
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
