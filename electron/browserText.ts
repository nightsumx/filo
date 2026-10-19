// The parts of the Browser tool window that are plain text in, plain text out: addresses, the page as
// the agent reads it (the accessibility tree as an outline with refs), key names, console lines.
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------- addresses

const LOCAL_HOST = /^(?:localhost|.*\.localhost|.*\.local|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/i
const SEARCH = 'https://duckduckgo.com/?q='

/**
 * What an address bar or `browser_navigate` text means: a URL. Pages load over http(s) or from a file;
 * `javascript:`, `chrome:` and the schemes of other apps (`slack:`, `mailto:`) are refused. Without a
 * scheme, local hosts get http and the rest https. `search`: text that is no address becomes a search
 * (the address bar), else it is an error (the agent).
 */
export function parseAddress(input: string, search = false): string {
    const text = input.trim()
    if (!text)
        throw new Error('the address is empty')
    if (text.startsWith('/') || text.startsWith('~/'))
        return pathToFileURL(text.startsWith('~/') ? `${process.env.HOME ?? ''}${text.slice(1)}` : text).href
    // `localhost:3000/x` starts like a scheme but is a host and a port.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)
    if (scheme && !/^[^/\s:]+:\d+(?:[/?#]|$)/.test(text)) {
        const name = scheme[1].toLowerCase()
        if (name === 'about' && text.toLowerCase() === 'about:blank')
            return 'about:blank'
        if (name !== 'http' && name !== 'https' && name !== 'file')
            throw new Error(`the browser opens http, https and file addresses, not ${name}:`)
        return new URL(text).href
    }
    const host = /^(\[[^\]]*\]|[^/\s:?#]*)/.exec(text)?.[1] ?? ''
    if (!(host.includes('.') || LOCAL_HOST.test(host)) || /\s/.test(text)) {
        if (search)
            return `${SEARCH}${encodeURIComponent(text)}`
        throw new Error(`"${text}" is not an address; give a full URL like https://example.com or http://localhost:3000`)
    }
    return new URL(`${LOCAL_HOST.test(host) ? 'http' : 'https'}://${text}`).href
}

/** Whether a page may be loaded from this URL (redirects and links are checked with it). */
export function allowedScheme(url: string): boolean {
    return /^(?:https?:|file:|about:blank$)/i.test(url)
}

// ---------------------------------------------------------------- the page as text

interface AxValue { value?: unknown }
/** The part of a CDP Accessibility.AXNode that the outline reads. */
export interface AxNode {
    nodeId: string
    ignored?: boolean
    role?: AxValue
    name?: AxValue
    value?: AxValue
    properties?: { name: string, value: AxValue }[]
    parentId?: string
    childIds?: string[]
    backendDOMNodeId?: number
}

const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'MenuListOption',
    'slider',
    'spinbutton',
    'treeitem',
    'DisclosureTriangle',
    'PopUpButton',
])
/** Wrappers with no meaning of their own: their children are listed in their place. */
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'paragraph', 'group', 'RootWebArea', 'WebArea', 'section', 'MenuListPopup', 'strong', 'emphasis', 'mark', 'time'])
/** Nothing to list: layout. (A label's own text is the name of its control, so it is not repeated, but a control inside the label stays.) */
const SKIPPED = new Set(['InlineTextBox', 'LineBreak'])
const ROLE_NAMES: Record<string, string> = { MenuListOption: 'option', PopUpButton: 'combobox', DisclosureTriangle: 'button' }
const WITH_VALUE = new Set(['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'PopUpButton'])
/** Properties shown when set; for these, `false` says something too. */
const FLAGS = ['checked', 'pressed', 'expanded', 'selected', 'disabled', 'required', 'invalid', 'focused', 'readonly'] as const
const FALSE_MATTERS = new Set<string>(['checked', 'pressed', 'expanded', 'selected'])

const MAX_NAME = 160
const MAX_TEXT = 240

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text
const clean = (text: string) => text.replace(/\s+/g, ' ').trim()

export interface OutlineOptions {
    /** The ref a node gets (the same node keeps its ref from one snapshot to the next). */
    refOf: (backendNodeId: number) => string
    /** Start at this node instead of the page's root. */
    from?: number
    /** Characters before the outline is cut. */
    limit?: number
}

/**
 * The page as an outline, one line per thing a person would name: `- button "Sign in" [ref=e5]`.
 * What can be clicked or typed into carries a ref; text, headings and structure do not. Text that only
 * repeats its parent's name is left out, and so are wrappers without a meaning.
 */
export function renderOutline(nodes: AxNode[], options: OutlineOptions): { text: string, truncated: boolean, refs: number } {
    const byId = new Map(nodes.map(n => [n.nodeId, n]))
    const roots = options.from === undefined
        ? nodes.filter(n => !n.parentId || !byId.has(n.parentId)).slice(0, 1)
        : nodes.filter(n => n.backendDOMNodeId === options.from)
    const limit = options.limit ?? 14_000
    const lines: string[] = []
    let size = 0
    let truncated = false
    let refs = 0

    const emit = (line: string): boolean => {
        if (size + line.length > limit) {
            truncated = true
            return false
        }
        lines.push(line)
        size += line.length + 1
        return true
    }

    const walk = (node: AxNode, depth: number, parentName: string): boolean => {
        const role = String(node.role?.value ?? '')
        const into = (childDepth: number, name: string) => {
            for (const id of node.childIds ?? []) {
                const child = byId.get(id)
                if (child && !walk(child, childDepth, name))
                    return false
            }
            return true
        }
        if (SKIPPED.has(role))
            return true
        const name = clean(String(node.name?.value ?? ''))
        if (role === 'LabelText') {
            for (const id of node.childIds ?? []) {
                const child = byId.get(id)
                if (child && String(child.role?.value) !== 'StaticText' && !walk(child, depth, parentName))
                    return false
            }
            return true
        }
        if (node.ignored || TRANSPARENT.has(role))
            return into(depth, parentName)
        if (role === 'StaticText') {
            // "Sign in" inside a button named "Sign in" says nothing new.
            if (!name || (parentName && parentName.includes(name)))
                return true
            return emit(`${'  '.repeat(depth)}- text: ${JSON.stringify(clip(name, MAX_TEXT))}`)
        }
        const props = new Map((node.properties ?? []).map(p => [p.name, p.value.value]))
        const parts = [`- ${ROLE_NAMES[role] ?? role}`]
        if (name)
            parts.push(JSON.stringify(clip(name, MAX_NAME)))
        const level = props.get('level')
        if (level !== undefined)
            parts.push(`[level=${String(level)}]`)
        for (const flag of FLAGS) {
            const v = props.get(flag)
            if (v === true)
                parts.push(`[${flag}]`)
            else if (v === 'mixed' || (v === false && FALSE_MATTERS.has(flag)))
                parts.push(`[${flag}=${String(v)}]`)
        }
        const value = node.value?.value
        if (WITH_VALUE.has(role) && value !== undefined && value !== '' && value !== name)
            parts.push(`value=${JSON.stringify(clip(String(value), MAX_NAME))}`)
        const href = props.get('url')
        if (role === 'link' && typeof href === 'string')
            parts.push(`href=${JSON.stringify(clip(href, 200))}`)
        if (node.backendDOMNodeId !== undefined && (INTERACTIVE.has(role) || props.get('focusable') === true)) {
            parts.push(`[ref=${options.refOf(node.backendDOMNodeId)}]`)
            refs++
        }
        if (!emit(`${'  '.repeat(depth)}${parts.join(' ')}`))
            return false
        // A field's text is its value, already shown.
        if (role === 'textbox' || role === 'searchbox')
            return true
        return into(depth + 1, name)
    }

    for (const root of roots)
        walk(root, 0, '')
    return { text: lines.join('\n'), truncated, refs }
}

// ---------------------------------------------------------------- keys

export interface KeyPress {
    key: string
    code: string
    windowsVirtualKeyCode: number
    /** CDP bits: 1 Alt, 2 Control, 4 Meta, 8 Shift. */
    modifiers: number
    text?: string
    /** Editing commands the keys stand for (Meta+A): synthetic key events do not run them by themselves. */
    commands?: string[]
}

const NAMED: Record<string, { key: string, code: string, vk: number, text?: string }> = {
    enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
    escape: { key: 'Escape', code: 'Escape', vk: 27 },
    esc: { key: 'Escape', code: 'Escape', vk: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    delete: { key: 'Delete', code: 'Delete', vk: 46 },
    insert: { key: 'Insert', code: 'Insert', vk: 45 },
    space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    home: { key: 'Home', code: 'Home', vk: 36 },
    end: { key: 'End', code: 'End', vk: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}
for (let i = 1; i <= 12; i++)
    NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i }

const MODIFIERS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
const EDIT_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' }

/**
 * `Enter`, `Escape`, `ArrowDown`, `Control+A`, `Meta+Shift+Z`, `a`. `ControlOrMeta` is Meta on a Mac and
 * Control elsewhere (`mac`).
 */
export function parseKey(spec: string, mac: boolean): KeyPress {
    const trimmed = spec.trim()
    if (!trimmed)
        throw new Error('key is empty')
    // The key itself may be "+": "+", "Shift++".
    const plus = trimmed === '+' || trimmed.endsWith('++')
    const names = plus ? trimmed.slice(0, -2).split('+').filter(Boolean) : trimmed.split('+')
    const last = plus ? '+' : names.pop() ?? ''
    let modifiers = 0
    for (const name of names) {
        const lower = name.toLowerCase()
        const bit = lower === 'controlormeta' ? (mac ? 4 : 2) : MODIFIERS[lower]
        if (!bit)
            throw new Error(`unknown modifier "${name}" in "${spec}"; use Alt, Control, Meta, Shift or ControlOrMeta`)
        modifiers |= bit
    }
    // Control or Meta without Alt: a shortcut, which types nothing.
    const shortcut = (modifiers & 6) !== 0 && (modifiers & 1) === 0
    const named = NAMED[last.toLowerCase()]
    if (named)
        return { key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, modifiers, ...(named.text && !shortcut ? { text: named.text } : {}) }
    if (last.length !== 1)
        throw new Error(`unknown key "${last}"; use a single character or a name like Enter, Escape, Tab, ArrowDown, PageDown, F5`)
    const upper = last.toUpperCase()
    const shifted = (modifiers & 8) !== 0
    const isLetter = /[a-z]/i.test(last)
    const isDigit = /\d/.test(last)
    const key = isLetter ? (shifted ? upper : last.toLowerCase()) : last
    const command = shortcut && isLetter ? EDIT_COMMANDS[last.toLowerCase()] : undefined
    return {
        key,
        code: isLetter ? `Key${upper}` : isDigit ? `Digit${last}` : '',
        windowsVirtualKeyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
        modifiers,
        ...(!shortcut && (modifiers & 1) === 0 ? { text: key } : {}),
        ...(command ? { commands: [command === 'undo' && shifted ? 'redo' : command] } : {}),
    }
}

// ---------------------------------------------------------------- console

export interface ConsoleLine {
    level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'dialog'
    text: string
    source?: string
}

/** Electron's console-message level names → ours. */
export function consoleLevel(level: string): ConsoleLine['level'] {
    return level === 'warning' ? 'warn' : level === 'error' || level === 'debug' || level === 'info' ? level : 'log'
}

export function formatConsole(lines: ConsoleLine[]): string {
    return lines.map(l => `[${l.level}] ${clip(l.text.replace(/\n+/g, ' ⏎ '), 600)}${l.source ? ` (${l.source})` : ''}`).join('\n')
}
