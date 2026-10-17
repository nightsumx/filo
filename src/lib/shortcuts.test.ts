import type { KeyEvent, Shortcut } from './shortcuts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMac, os } from '../platform'
import { SHORTCUTS, shortcutKeys, shortcutOf } from './shortcuts'

const root = path.join(__dirname, '..', '..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

const NAMED: Record<string, { key: string, code?: string }> = {
    '↩': { key: 'Enter' },
    '↑': { key: 'ArrowUp' },
    'Esc': { key: 'Escape' },
    '`': { key: '`', code: 'Backquote' },
}

/** The event the keyboard sends for a shortcut written the macOS way ("⌘⇧E", "⌃1–9", "⌥↑"). */
function eventFor(mac: string): KeyEvent {
    const mods = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
    const flags: Record<string, keyof typeof mods> = { '⌘': 'metaKey', '⌃': 'ctrlKey', '⌥': 'altKey', '⇧': 'shiftKey' }
    let rest = mac
    while (flags[rest[0]]) {
        mods[flags[rest[0]]] = true
        rest = rest.slice(1)
    }
    // "1–9" is a range of keys; try its first.
    const name = rest.includes('–') ? rest.split('–')[0] : rest
    const named = NAMED[name] ?? { key: name.length === 1 && mods.shiftKey ? name.toUpperCase() : name }
    return { ...mods, key: named.key, code: named.code ?? `Key${named.key.toUpperCase()}` }
}

// These tests describe macOS, which is also what Node reports to platform.ts.
describe.runIf(isMac)('shortcuts', () => {
    const matched = SHORTCUTS.filter((s): s is Extract<typeof s, { match: unknown }> => 'match' in s)

    it('every shortcut that has a matcher answers to each of its own keys', () => {
        for (const s of matched) {
            for (const mac of s.keys) {
                const found = SHORTCUTS.filter(o => o.scope === s.scope && 'match' in o && (o as Shortcut).match!(eventFor(mac))).map(o => o.id)
                expect(found, `${s.id} ${mac}`).toEqual([s.id])
            }
        }
    })

    it('a shifted bracket still counts, whatever the layout calls it', () => {
        expect(shortcutOf('app', { ...eventFor('⌘⇧]'), key: '}' })).toBe('next-tab')
        expect(shortcutOf('app', { ...eventFor('⌘⇧['), key: '{' })).toBe('previous-tab')
    })

    it('tells the 1–9 digits of tabs and of projects apart', () => {
        expect(shortcutOf('app', { ...eventFor('⌘1'), key: '9' })).toBe('focus-tab')
        expect(shortcutOf('app', { ...eventFor('⌃1'), key: '9' })).toBe('project')
        expect(shortcutOf('app', eventFor('⌘0'))).toBeUndefined()
    })

    it('keys no shortcut has are nobody\'s', () => {
        expect(shortcutOf('app', eventFor('⌘J'))).toBeUndefined()
        expect(shortcutOf('app', eventFor('⌘⇧T'))).toBeUndefined()
        expect(shortcutOf('terminal', eventFor('⌘J'))).toBeUndefined()
    })

    it('the ones without a matcher are the ones bound elsewhere, on purpose', () => {
        expect(SHORTCUTS.filter(s => !('match' in s)).map(s => s.id).sort()).toEqual(['newline', 'save', 'send', 'settings', 'stop', 'submit-field'])
    })

    it('has no id twice', () => {
        const ids = SHORTCUTS.map(s => s.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it('is what the key handlers ask: each matched shortcut is named where it is acted on, and they do not judge keys themselves', () => {
        const handlers = ['src/App.tsx', 'src/features/Toolbar/index.tsx', 'src/features/Terminal/index.tsx', 'src/features/Composer/index.tsx'].map(read)
        for (const s of matched)
            expect(handlers.some(h => h.includes(`'${s.id}'`)), s.id).toBe(true)
        for (const h of handlers)
            expect(h).not.toMatch(/\b(commandKey|terminalCommand)\(/)
    })

    it('writes keys the platform way', () => {
        expect(shortcutKeys('new-thread')).toEqual(['⌘T'])
        expect(shortcutKeys('next-tab')).toEqual(['⌃Tab', '⌘⇧]'])
        expect(os).toBe('mac')
    })
})
