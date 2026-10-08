import { afterEach, describe, expect, it, vi } from 'vitest'

/** src/platform.ts as it loads under the given user agent. */
async function load(userAgent: string) {
    vi.resetModules()
    vi.stubGlobal('navigator', { userAgent, language: 'en-US' })
    return import('./platform')
}

const key = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}, code = '') =>
    ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('renderer platform', () => {
    it('keeps the macOS hints as written', async () => {
        const p = await load('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/37')
        expect(p.os).toBe('mac')
        expect(p.keys('⌘⇧F')).toBe('⌘⇧F')
        expect(p.keys('⌘ Enter')).toBe('⌘ Enter')
        expect(p.projectKeys(3)).toBe('⌃3')
        expect(p.terminalKeys('K')).toBe('⌘K')
        expect(p.showInFolderLabel()).toMatch(/Finder/)
    })

    it('reads them as Ctrl/Shift/Alt on Windows and Linux', async () => {
        const p = await load('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/37')
        expect(p.os).toBe('windows')
        expect(p.keys('⌘⇧F')).toBe('Ctrl+Shift+F')
        expect(p.keys('⌘ Enter')).toBe('Ctrl+Enter')
        expect(p.keys('⌘↩')).toBe('Ctrl+Enter')
        expect(p.keys('⌃Tab')).toBe('Ctrl+Tab')
        expect(p.keys('⌘\\')).toBe('Ctrl+\\')
        expect(p.projectKeys(3)).toBe('Alt+3')
        expect(p.terminalKeys('K')).toBe('Ctrl+Shift+K')
        expect((await load('Mozilla/5.0 (X11; Linux x86_64) Electron/37')).os).toBe('linux')
    })

    it('maps the shortcut modifiers per OS', async () => {
        const mac = await load('Macintosh')
        expect(mac.commandKey(key('t', { metaKey: true }))).toBe(true)
        expect(mac.commandKey(key('t', { ctrlKey: true }))).toBe(false)
        expect(mac.projectDigit(key('2', { ctrlKey: true }))).toBe(2)
        expect(mac.projectDigit(key('2', { metaKey: true }))).toBe(0)

        const win = await load('Windows NT')
        expect(win.commandKey(key('t', { ctrlKey: true }))).toBe(true)
        expect(win.commandKey(key('t', { metaKey: true }))).toBe(false)
        expect(win.projectDigit(key('2', { altKey: true }))).toBe(2)
        expect(win.projectDigit(key('2', { ctrlKey: true }))).toBe(0)
        expect(win.terminalCommand(key('W', { ctrlKey: true, shiftKey: true }))).toBe(true)
        expect(win.terminalCommand(key('w', { ctrlKey: true }))).toBe(false)
    })

    it('leaves the shell its Ctrl keys outside macOS', async () => {
        const win = await load('Windows NT')
        // Ctrl+W deletes a word, Ctrl+R searches history, Ctrl+C interrupts.
        for (const k of ['w', 'r', 'c', 'p', 'b'])
            expect(win.appTakesFromTerminal(key(k, { ctrlKey: true }))).toBe(false)
        expect(win.appTakesFromTerminal(key('T', { ctrlKey: true, shiftKey: true }))).toBe(true)
        expect(win.appTakesFromTerminal(key('Tab', { ctrlKey: true }))).toBe(true)
        expect(win.appTakesFromTerminal(key('`', { ctrlKey: true }, 'Backquote'))).toBe(true)
        expect(win.appTakesFromTerminal(key('3', { altKey: true }))).toBe(true)
        expect(win.lineMotion(key('ArrowLeft', { altKey: true }))).toBeUndefined()

        const mac = await load('Macintosh')
        expect(mac.appTakesFromTerminal(key('w', { metaKey: true }))).toBe(true)
        expect(mac.appTakesFromTerminal(key('w', { ctrlKey: true }))).toBe(false)
        expect(mac.lineMotion(key('ArrowLeft', { metaKey: true }))).toBe('\x01')
    })

    it('previews QuickLook types only on macOS', async () => {
        await load('Macintosh')
        expect((await import('./lib/filePreview')).previewOf('a.docx')?.kind).toBe('quicklook')
        await load('Windows NT')
        expect((await import('./lib/filePreview')).previewOf('a.docx')).toBeNull()
        expect((await import('./lib/filePreview')).previewOf('a.png')?.kind).toBe('image')
    })
})
