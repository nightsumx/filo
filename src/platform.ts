// The renderer's OS conventions: shortcut keys and how they read, the title bar's reserved space,
// the file manager's name. The only place in src/ that knows which OS it runs on
// (electron/platform/platform.test.ts holds it to that).
//
// Shortcuts are written the macOS way throughout the UI (⌘T, ⌃Tab) and read as Ctrl+T, Ctrl+Tab on
// Windows and Linux. Two groups move there, since Ctrl+letter already belongs to the shell and Ctrl+digit
// takes the ⌘ digits: projects (⌃1–9) are Alt+1–9, and the terminal's own shortcuts (⌘T/W/K/C/V) are
// Ctrl+Shift+letter, as in Windows Terminal and GNOME Terminal.
import type { CSSProperties } from 'react'
import { tr } from './lib/i18n'

export type Os = 'mac' | 'windows' | 'linux'

function detect(): Os {
    // Electron's user agent names the OS; outside it (unit tests in Node) this reads as macOS.
    const agent = globalThis.navigator?.userAgent ?? ''
    if (agent.includes('Windows'))
        return 'windows'
    if (/Linux|X11|CrOS/.test(agent))
        return 'linux'
    return 'mac'
}

export const os: Os = detect()
export const isMac = os === 'mac'

const PC_NAMES: Record<string, string> = { '⌃': 'Ctrl', '⌘': 'Ctrl', '⇧': 'Shift', '⌥': 'Alt' }
const PC_ORDER = ['Ctrl', 'Shift', 'Alt']

/** A shortcut as this OS writes it: keys('⌘⇧F') is itself on macOS and 'Ctrl+Shift+F' elsewhere. */
export function keys(mac: string): string {
    if (isMac)
        return mac
    let i = 0
    const mods = new Set<string>()
    while (i < mac.length && PC_NAMES[mac[i]])
        mods.add(PC_NAMES[mac[i++]])
    const key = mac.slice(i).trim().replace('↩', 'Enter')
    return [...PC_ORDER.filter(m => mods.has(m)), key].join('+')
}

/** The hint for the n-th project's shortcut: ⌃n on macOS, Alt+n elsewhere. */
export function projectKeys(n: number): string {
    return isMac ? `⌃${n}` : `Alt+${n}`
}

/** The hint for a terminal shortcut: ⌘K on macOS, Ctrl+Shift+K elsewhere. */
export function terminalKeys(key: string): string {
    return isMac ? `⌘${key}` : `Ctrl+Shift+${key}`
}

interface Mods { metaKey: boolean, ctrlKey: boolean, altKey: boolean, shiftKey: boolean }

/** The app's command modifier is held (⌘ on macOS, Ctrl elsewhere) and neither of the others; Shift is up to the caller. */
export function commandKey(e: Mods): boolean {
    return isMac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && !e.metaKey && !e.altKey
}

/** 1–9 for the project shortcut (⌃1–9 on macOS, Alt+1–9 elsewhere), else 0. */
export function projectDigit(e: Mods & { key: string }): number {
    const held = isMac ? e.ctrlKey && !e.metaKey : e.altKey && !e.ctrlKey && !e.metaKey
    return held && /^[1-9]$/.test(e.key) ? Number(e.key) : 0
}

/** A terminal shortcut's modifiers: ⌘ alone on macOS, Ctrl+Shift elsewhere. */
export function terminalCommand(e: Mods): boolean {
    return isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
        : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
}

/** Keys the app takes even while a terminal has focus; everything else goes to the program running there. */
export function appTakesFromTerminal(e: Mods & { key: string, code: string }): boolean {
    if (e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.code === 'Backquote'))
        return true
    // ⌘ combos never mean anything to the shell; copy and paste come through the Edit menu.
    if (isMac)
        return e.metaKey && !['ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.key)
    // Ctrl+Shift+letter and the digit shortcuts are the app's; plain Ctrl+letter is the shell's.
    return (e.ctrlKey && e.shiftKey && !e.altKey) || (/^[1-9]$/.test(e.key) && (e.ctrlKey !== e.altKey) && !e.shiftKey)
}

/** macOS text-field motions, translated to what line editors (zsh, bash, fish) understand. */
const MAC_MOTIONS: Record<string, string> = {
    'Meta+ArrowLeft': '\x01',
    'Meta+ArrowRight': '\x05',
    'Meta+Backspace': '\x15',
    'Alt+ArrowLeft': '\x1Bb',
    'Alt+ArrowRight': '\x1Bf',
    'Alt+Backspace': '\x17',
}

/** What to send the shell for a text-editing motion key, if this OS has its own; Home/End and Ctrl+arrows need none. */
export function lineMotion(e: Mods & { key: string }): string | undefined {
    if (!isMac || e.shiftKey || e.ctrlKey)
        return undefined
    return MAC_MOTIONS[`${e.metaKey ? 'Meta+' : e.altKey ? 'Alt+' : ''}${e.key}`]
}

/**
 * Room the toolbar leaves for the window buttons: the traffic lights on the left on macOS; elsewhere the
 * caption buttons the OS draws over the right end (titleBarOverlay), whose width CSS reads from env().
 */
export const titleBarInset: { className: string, style?: CSSProperties } = isMac
    ? { className: 'pl-[78px] pr-2' }
    : { className: 'pl-2', style: { paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 8px)' } }

/** The menu item that shows a folder in the OS file manager. */
export function showInFolderLabel(): string {
    if (os === 'windows')
        return tr('在资源管理器中打开', 'Show in Explorer')
    if (os === 'linux')
        return tr('在文件管理器中打开', 'Open in File Manager')
    return tr('在 Finder 中打开', 'Show in Finder')
}

const isWindows = os === 'windows'

/** A local path's parts; Windows paths take both \\ and /. */
export function pathParts(p: string): string[] {
    return isWindows ? p.split(/[\\/]/) : p.split('/')
}

export function isAbsolutePath(p: string): boolean {
    return isWindows ? /^(?:[a-z]:[\\/]|\\\\)/i.test(p) : p.startsWith('/')
}

/** `p` relative to the folder `dir` when it is inside it (case-insensitive on Windows), else undefined. */
export function insideOf(p: string, dir: string): string | undefined {
    if (!isWindows) {
        const base = dir.endsWith('/') ? dir : `${dir}/`
        return p.startsWith(base) ? p.slice(base.length) : undefined
    }
    const norm = (s: string) => s.replaceAll('/', '\\').toLowerCase()
    const base = norm(dir).replace(/\\?$/, '\\')
    return norm(p).startsWith(base) ? p.slice(base.length) : undefined
}

/** The folder holding `p`: "/a/b/c" → "/a/b". */
export function parentPath(p: string): string {
    return isWindows ? p.replace(/[\\/][^\\/]+$/, '') : p.replace(/\/[^/]+$/, '')
}

/** The home folder as ~: "/Users/me/code" → "~/code", "C:\\Users\\me\\code" → "~\\code". */
export function homeShort(p: string): string {
    return isWindows
        ? p.replace(/^[a-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i, '~')
        : p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** QuickLook thumbnails (documents, HEIC, PSD...) exist only on macOS. */
export const hasQuickLook = isMac
