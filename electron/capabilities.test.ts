import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CAPABILITIES, DEFAULT_CAPABILITIES, normalizeCapabilities, PRESETS } from '@shared/capabilities'
import { describe, expect, it } from 'vitest'
import { capabilityArgs } from './capabilities'

describe('capabilityArgs', () => {
    it('maps ids to -e paths in catalogue order and drops unknown ids', () => {
        expect(capabilityArgs(['ask', 'nope', 'todo', 'ask'], '/ext')).toEqual(['-e', '/ext/todo.ts', '-e', '/ext/ask.ts'])
        expect(capabilityArgs(undefined, '/ext')).toEqual([])
        expect(capabilityArgs('todo', '/ext')).toEqual([])
    })

    it('passes the approval mode only when approval loads', () => {
        expect(capabilityArgs(['approval'], '/ext', { approvalMode: 'edits' })).toEqual(['-e', '/ext/approval.ts', '--gui-approval', 'edits'])
        expect(capabilityArgs(['todo'], '/ext', { approvalMode: 'edits' })).toEqual(['-e', '/ext/todo.ts'])
        expect(capabilityArgs(['approval'], '/ext', { approvalMode: 'bogus' as any })).toEqual(['-e', '/ext/approval.ts'])
    })
})

describe('capability catalogue', () => {
    it('every entry file exists and presets only name known capabilities', () => {
        for (const c of CAPABILITIES)
            expect(existsSync(path.resolve(__dirname, '../extensions', c.entry)), c.entry).toBe(true)
        for (const p of PRESETS)
            expect(normalizeCapabilities(p.capabilities)).toEqual([...p.capabilities])
        expect(DEFAULT_CAPABILITIES.length).toBeGreaterThan(0)
    })
})

describe('extension files', () => {
    // Packaged builds ship extensions/*.ts alone (Resources/extensions); pi resolves only its own
    // packages and typebox for them. Anything else must be a type import, which jiti strips.
    const dir = path.join(import.meta.dirname, '../extensions')
    it.each(readdirSync(dir).filter(f => f.endsWith('.ts')))('%s imports only what pi provides at runtime', (file) => {
        const source = readFileSync(path.join(dir, file), 'utf8')
        const valueImports = [...source.matchAll(/^import\s+(?!type\s)[^'"]*?from\s+'([^']+)'/gm)].map(m => m[1])
        expect(valueImports.filter(spec => !spec.startsWith('node:') && spec !== 'typebox' && !spec.startsWith('@earendil-works/'))).toEqual([])
    })
})
