import { existsSync } from 'node:fs'
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
