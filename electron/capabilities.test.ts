import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CAPABILITIES, DEFAULT_CAPABILITIES, normalizeCapabilities, PRESETS } from '@shared/capabilities'
import { describe, expect, it } from 'vitest'
import { capabilityArgs } from './capabilities'

describe('capabilityArgs', () => {
    it('maps ids to -e paths in catalogue order and drops unknown ids', () => {
        expect(capabilityArgs(['ask', 'nope', 'todo', 'ask'], '/ext')).toEqual(['-e', path.join('/ext', 'todo.ts'), '-e', path.join('/ext', 'ask.ts')])
        expect(capabilityArgs(undefined, '/ext')).toEqual([])
        expect(capabilityArgs('todo', '/ext')).toEqual([])
    })

    it('passes the approval mode only when approval loads', () => {
        expect(capabilityArgs(['approval'], '/ext', { approvalMode: 'edits' })).toEqual(['-e', path.join('/ext', 'approval.ts'), '--gui-approval', 'edits'])
        expect(capabilityArgs(['todo'], '/ext', { approvalMode: 'edits' })).toEqual(['-e', path.join('/ext', 'todo.ts')])
        expect(capabilityArgs(['approval'], '/ext', { approvalMode: 'bogus' as any })).toEqual(['-e', path.join('/ext', 'approval.ts')])
    })
})

describe('capability catalogue', () => {
    it('every entry file exists and presets only name known capabilities', () => {
        for (const c of CAPABILITIES)
            expect(existsSync(path.resolve(__dirname, '../packages/capabilities/extensions', c.entry)), c.entry).toBe(true)
        for (const p of PRESETS)
            expect(normalizeCapabilities(p.capabilities)).toEqual([...p.capabilities])
        expect(DEFAULT_CAPABILITIES.length).toBeGreaterThan(0)
    })
})

describe('capability package files', () => {
    // Packaged builds ship the pi-capabilities package alone (Resources/capabilities); pi resolves only
    // its own packages and typebox for it. Anything else must be a file inside the package or a type
    // import, which jiti strips.
    const root = path.join(import.meta.dirname, '../packages/capabilities')
    const files = ['extensions', 'tui', 'lib'].flatMap(d => existsSync(path.join(root, d)) ? readdirSync(path.join(root, d)).filter(f => f.endsWith('.ts')).map(f => `${d}/${f}`) : [])
    it.each(files)('%s imports only what pi provides at runtime', (file) => {
        const source = readFileSync(path.join(root, file), 'utf8')
        const valueImports = [...source.matchAll(/^import\s+(?!type\s)[^'"]*?from\s+'([^']+)'/gm)].map(m => m[1])
        const outside = valueImports.filter(spec => spec.startsWith('.') && path.relative(root, path.resolve(root, path.dirname(file), spec)).startsWith('..'))
        expect(outside).toEqual([])
        expect(valueImports.filter(spec => !spec.startsWith('.') && !spec.startsWith('node:') && spec !== 'typebox' && !spec.startsWith('@earendil-works/'))).toEqual([])
    })
})
