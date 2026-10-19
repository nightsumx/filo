// Every keyboard shortcut of the app, in one list: the Settings → Shortcuts page shows it and the key
// handlers (App.tsx, Toolbar, Terminal, Composer) ask it which shortcut an event is, so changing a key
// here changes it everywhere and the page cannot drift from what works. `keys` are written the macOS way
// (src/platform.ts keys() turns them into Ctrl+… elsewhere); `on` lists the exceptions per OS.
// shortcuts.test.ts builds an event from each `keys` and checks `match` answers to it.
//
// Not matched here: the menu's ⌘, (electron/main.ts), the editor's ⌘S (features/Editor/litcode.ts), and
// ⌘↩ in the text fields that submit with it — the page lists them, the owners bind them.
import type { Localized } from '@shared/i18n'
import type { Os } from '@/platform'
import { commandKey, isMac, keys, os, projectDigit, terminalCommand, terminalKeys } from '@/platform'

/** The parts of a KeyboardEvent a shortcut looks at. */
export interface KeyEvent {
    key: string
    code: string
    metaKey: boolean
    ctrlKey: boolean
    altKey: boolean
    shiftKey: boolean
}

export type ShortcutScope = 'app' | 'composer' | 'terminal' | 'editor' | 'fields'

export interface Shortcut {
    id: string
    scope: ShortcutScope
    /** macOS notation; each entry is one way to do it. */
    keys: readonly string[]
    /** Written out where an OS differs by more than modifier names. */
    on?: Partial<Record<Os, readonly string[]>>
    label: Localized
    /** Whether an event is this shortcut. Absent when another part binds the key (see the top). */
    match?: (e: KeyEvent) => boolean
}

const letter = (e: KeyEvent) => e.key.toLowerCase()
/** 1–9 for a digit key, else 0. */
const digit = (e: KeyEvent) => e.key.length === 1 && Number(e.key) >= 1 ? Number(e.key) : 0
const command = (e: KeyEvent, key: string, shift = false) => commandKey(e) && e.shiftKey === shift && letter(e) === key
const bracket = (e: KeyEvent, shifted: string, plain: string) => commandKey(e) && e.shiftKey && (e.key === plain || e.key === shifted)
const ctrlTab = (e: KeyEvent, shift: boolean) => e.ctrlKey && !e.metaKey && e.key === 'Tab' && e.shiftKey === shift

export const SHORTCUTS = [
    { id: 'new-thread', scope: 'app', keys: ['⌘T'], label: { zh: '新线程', en: 'New thread' }, match: e => command(e, 't') },
    { id: 'close-tab', scope: 'app', keys: ['⌘W'], label: { zh: '关闭标签', en: 'Close tab' }, match: e => command(e, 'w') },
    { id: 'focus-tab', scope: 'app', keys: ['⌘1–9'], label: { zh: '切到第 1–9 个标签（⌘9 是最后一个）', en: 'Go to tab 1–9 (⌘9 is the last)' }, match: e => commandKey(e) && digit(e) > 0 },
    { id: 'next-tab', scope: 'app', keys: ['⌃Tab', '⌘⇧]'], label: { zh: '下一个标签', en: 'Next tab' }, match: e => ctrlTab(e, false) || bracket(e, '}', ']') },
    { id: 'previous-tab', scope: 'app', keys: ['⌃⇧Tab', '⌘⇧['], label: { zh: '上一个标签', en: 'Previous tab' }, match: e => ctrlTab(e, true) || bracket(e, '{', '[') },
    { id: 'project', scope: 'app', keys: ['⌃1–9'], on: { windows: ['Alt+1–9'], linux: ['Alt+1–9'] }, label: { zh: '切到第 1–9 个项目', en: 'Go to project 1–9' }, match: e => projectDigit(e) > 0 },
    { id: 'switch-project', scope: 'app', keys: ['⌘P'], label: { zh: '切换项目（搜索）', en: 'Switch project (search)' }, match: e => command(e, 'p') },
    { id: 'layout', scope: 'app', keys: ['⌘\\'], label: { zh: '分栏 / 单栏', en: 'Split / single pane' }, match: e => commandKey(e) && e.key === '\\' },
    { id: 'sidebar', scope: 'app', keys: ['⌘B'], label: { zh: '显示 / 隐藏项目面板', en: 'Show / hide the projects panel' }, match: e => command(e, 'b') },
    { id: 'files', scope: 'app', keys: ['⌘⇧E'], label: { zh: '打开文件树', en: 'Open the file tree' }, match: e => command(e, 'e', true) },
    { id: 'search', scope: 'app', keys: ['⌘⇧F'], label: { zh: '搜索线程', en: 'Search threads' }, match: e => command(e, 'f', true) },
    { id: 'terminal', scope: 'app', keys: ['⌃`'], label: { zh: '打开 / 隐藏终端面板', en: 'Open / hide the terminal panel' }, match: e => e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote' },
    { id: 'browser', scope: 'app', keys: ['⌘⇧B'], label: { zh: '打开 / 隐藏浏览器面板', en: 'Open / hide the browser panel' }, match: e => command(e, 'b', true) },
    { id: 'commands', scope: 'app', keys: ['⌘/'], label: { zh: '技能与命令', en: 'Skills and commands' }, match: e => commandKey(e) && !e.shiftKey && e.key === '/' },
    { id: 'settings', scope: 'app', keys: ['⌘,'], label: { zh: '设置', en: 'Settings' } },

    { id: 'send', scope: 'composer', keys: ['↩'], label: { zh: '发送；运行中是引导（steer）', en: 'Send; while running, steer' } },
    { id: 'newline', scope: 'composer', keys: ['⇧↩'], label: { zh: '换行', en: 'New line' } },
    { id: 'follow-up', scope: 'composer', keys: ['⌥↩'], label: { zh: '排到这一轮之后（follow-up）', en: 'Queue after this run (follow-up)' }, match: e => e.altKey && e.key === 'Enter' },
    { id: 'dequeue', scope: 'composer', keys: ['⌥↑'], on: { windows: ['Alt+Q'] }, label: { zh: '把排队的消息全部撤回输入框', en: 'Take the queued messages back into the editor' }, match: e => e.altKey && (os === 'windows' ? e.code === 'KeyQ' : e.key === 'ArrowUp') },
    { id: 'stop', scope: 'composer', keys: ['Esc'], label: { zh: '运行中停止', en: 'Stop the run' } },

    { id: 'terminal-new', scope: 'terminal', keys: ['⌘T'], label: { zh: '新终端', en: 'New terminal' }, match: e => terminalCommand(e) && letter(e) === 't' },
    { id: 'terminal-close', scope: 'terminal', keys: ['⌘W'], label: { zh: '关闭终端', en: 'Close terminal' }, match: e => terminalCommand(e) && letter(e) === 'w' },
    { id: 'terminal-clear', scope: 'terminal', keys: ['⌘K'], label: { zh: '清屏', en: 'Clear' }, match: e => terminalCommand(e) && letter(e) === 'k' },
    { id: 'terminal-copy', scope: 'terminal', keys: ['⌘C'], label: { zh: '复制', en: 'Copy' }, match: e => terminalCommand(e) && letter(e) === 'c' },
    { id: 'terminal-paste', scope: 'terminal', keys: ['⌘V'], label: { zh: '粘贴', en: 'Paste' }, match: e => terminalCommand(e) && letter(e) === 'v' },

    { id: 'save', scope: 'editor', keys: ['⌘S'], label: { zh: '保存文件（停手后也会自动保存）', en: 'Save the file (it also saves itself shortly after you stop typing)' } },
    { id: 'submit-field', scope: 'fields', keys: ['⌘↩'], label: { zh: '提交（提问、计划修改意见、提交说明的输入框里）', en: 'Submit (in the ask, plan feedback and commit message fields)' } },
] as const satisfies readonly Shortcut[]

export type ShortcutId = (typeof SHORTCUTS)[number]['id']

/** The same list, for lookups that do not need each entry's literal type. */
const ALL: readonly Shortcut[] = SHORTCUTS

export const SCOPE_TITLE: Record<ShortcutScope, Localized> = {
    app: { zh: '窗口', en: 'Window' },
    composer: { zh: '输入框', en: 'Composer' },
    terminal: { zh: '终端面板（面板有焦点时）', en: 'Terminal panel (when focused)' },
    editor: { zh: '代码编辑器', en: 'Code editor' },
    fields: { zh: '输入框里的提交', en: 'Submitting from a field' },
}

/** The shortcut an event is, among those of `scope`. */
export function shortcutOf(scope: ShortcutScope, e: KeyEvent): ShortcutId | undefined {
    return ALL.find(s => s.scope === scope && s.match?.(e))?.id as ShortcutId | undefined
}

/** Whether an event is the shortcut `id`. */
export function isShortcut(id: ShortcutId, e: KeyEvent): boolean {
    return ALL.find(s => s.id === id)?.match?.(e) ?? false
}

/** A shortcut's keys as this OS writes them, one string per alternative. */
export function shortcutKeys(id: ShortcutId): string[] {
    const s = ALL.find(s => s.id === id)!
    const own = isMac ? undefined : s.on?.[os]
    if (own)
        return [...own]
    // The terminal's own shortcuts are Ctrl+Shift+letter elsewhere (platform.ts).
    return s.keys.map(k => s.scope === 'terminal' ? terminalKeys(k.slice(1)) : keys(k))
}
