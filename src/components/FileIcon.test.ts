import { describe, expect, it } from 'vitest'
import { iconKind, isTestFile } from './FileIcon'

describe('iconKind', () => {
    it('picks a mark by extension', () => {
        expect(iconKind('main.ts')).toMatchObject({ badge: 'TS' })
        expect(iconKind('vite.config.mts')).toMatchObject({ badge: 'TS' })
        expect(iconKind('a.mjs')).toMatchObject({ badge: 'JS' })
        expect(iconKind('App.tsx')).toEqual({ mark: 'react' })
        expect(iconKind('package.json')).toEqual({ mark: 'json' })
        expect(iconKind('README.MD')).toEqual({ mark: 'markdown' })
        expect(iconKind('logo.png')).toEqual({ mark: 'image' })
    })

    it('knows files by name before extension', () => {
        expect(iconKind('.gitignore')).toEqual({ mark: 'ignore' })
        expect(iconKind('bun.lock')).toEqual({ mark: 'bun' })
        expect(iconKind('yarn.lock')).toEqual({ mark: 'lock' })
        expect(iconKind('LICENSE')).toEqual({ mark: 'text' })
        expect(iconKind('Dockerfile')).toMatchObject({ badge: 'D' })
        expect(iconKind('eslint.config.mjs')).toEqual({ mark: 'eslint' })
        expect(iconKind('.env.local')).toEqual({ mark: 'config' })
    })

    it('falls back to a plain file', () => {
        expect(iconKind('data.bin')).toEqual({ mark: 'generic' })
        expect(iconKind('noext')).toEqual({ mark: 'generic' })
    })
})

describe('isTestFile', () => {
    it('recognises test and spec files', () => {
        expect(isTestFile('a.test.ts')).toBe(true)
        expect(isTestFile('b.spec.tsx')).toBe(true)
        expect(isTestFile('test_c.py')).toBe(true)
        expect(isTestFile('d_test.go')).toBe(true)
        expect(isTestFile('latest.ts')).toBe(false)
        expect(isTestFile('test.ts')).toBe(false)
    })
})
