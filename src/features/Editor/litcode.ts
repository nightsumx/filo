// lite-monaco (litcode) for the editor tabs: one Shiki highlighter for the app, languages loaded as
// files need them, colours from a VS Code theme with the app's own editor background, and the
// TypeScript standard library bundled with the app instead of fetched from a CDN.
import type { FileTab } from '@/store/fileTab'
import type { Highlighter } from 'shiki'
import type { ShikiLike, ThemeColors } from 'lite-monaco'
import { core, litcode, setTsLibLoader } from 'lite-monaco'
import { bundledLanguagesInfo, createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { tr } from '@/lib/i18n'
import { toLf } from '@/lib/textEdit'

/** Same family as the code blocks in the transcript (highlight.js github-dark / GitHub light). */
export const DARK_THEME = 'github-dark'
export const LIGHT_THEME = 'github-light'

// TypeScript's lib.*.d.ts go into the bundle as lazy chunks: completions and hover work offline,
// and the editor never reaches out to jsdelivr. A failed load throws, which keeps lite-monaco from
// falling back to the CDN.
const tsLibs = import.meta.glob<string>('/node_modules/typescript/lib/lib.*.d.ts', { query: '?raw', import: 'default' })
setTsLibLoader(async () => {
    const entries = await Promise.all(Object.entries(tsLibs).map(async ([path, load]) => [path.slice(path.lastIndexOf('/') + 1), await load()] as const))
    if (!entries.length)
        throw new Error('TypeScript libs are not bundled')
    return new Map(entries)
})

let shared: Promise<Highlighter> | null = null

/** The app's one highlighter (lite-monaco keys its token caches by it); themes up front, languages on demand. */
function highlighter(): Promise<Highlighter> {
    shared ??= createHighlighter({ themes: [DARK_THEME, LIGHT_THEME], langs: [], engine: createJavaScriptRegexEngine() })
    return shared
}

/** Whole file names Shiki knows by a language rather than an extension. */
const BY_NAME: Record<string, string> = {
    'dockerfile': 'docker',
    'makefile': 'make',
    'gnumakefile': 'make',
    'cmakelists.txt': 'cmake',
    '.env': 'dotenv',
    '.gitignore': 'shellscript',
    '.npmrc': 'ini',
    '.editorconfig': 'ini',
    '.bashrc': 'shellscript',
    '.zshrc': 'shellscript',
    '.profile': 'shellscript',
    'tsconfig.json': 'jsonc',
    'jsconfig.json': 'jsonc',
}

/** Extensions that are not a Shiki id or alias. */
const BY_EXT: Record<string, string> = {
    htm: 'html',
    svg: 'xml',
    plist: 'xml',
    h: 'c',
    hpp: 'cpp',
    hh: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    yml: 'yaml',
    jsonl: 'json',
    lock: 'json',
    zsh: 'shellscript',
    fish: 'fish',
    gql: 'graphql',
    kts: 'kotlin',
    mdc: 'markdown',
}

const byAlias = new Map<string, { id: string, name: string }>()
for (const info of bundledLanguagesInfo) {
    byAlias.set(info.id, info)
    for (const alias of info.aliases ?? [])
        byAlias.set(alias, info)
}

/** Shiki language for a file name, or null for plain text. */
export function languageOf(name: string): { id: string, name: string } | null {
    const lower = name.toLowerCase()
    const named = BY_NAME[lower] ?? (lower.startsWith('.env.') ? 'dotenv' : undefined)
    if (named)
        return byAlias.get(named) ?? null
    const dot = lower.lastIndexOf('.')
    if (dot <= 0)
        return null
    const ext = lower.slice(dot + 1)
    return byAlias.get(BY_EXT[ext] ?? ext) ?? null
}

export interface EditorKit {
    hl: Highlighter
    /** Shiki id, loaded; 'text' when there is none. */
    lang: string
    /** For the status bar. */
    languageName: string
}

/** The highlighter with the file's language in it (lite-monaco does not load languages itself). */
export async function prepare(name: string): Promise<EditorKit> {
    const hl = await highlighter()
    const language = languageOf(name)
    if (language) {
        try {
            await hl.loadLanguage(language.id as Parameters<Highlighter['loadLanguage']>[0])
            return { hl, lang: language.id, languageName: language.name }
        }
        catch {}
    }
    return { hl, lang: 'text', languageName: tr('纯文本', 'Plain text') }
}

/**
 * The theme's editor colours (as lite-monaco reads them) on the app's editor background, so the
 * editor, its gutter and minimap sit flat in the pane like the rest of the IDE.
 */
function colorsFor(hl: Highlighter, themeName: string): ThemeColors {
    const theme = hl.getTheme(themeName)
    const c = theme.colors ?? {}
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--ide-editor').trim() || theme.bg
    return {
        bg,
        fg: theme.fg,
        dark: theme.type === 'dark',
        shell: {
            lineNumber: c['editorLineNumber.foreground'],
            activeLineNumber: c['editorLineNumber.activeForeground'],
            lineHighlight: c['editor.lineHighlightBackground'],
            selection: c['editor.selectionBackground'],
            selectionMatch: c['editor.selectionHighlightBackground'],
            cursor: c['editorCursor.foreground'],
        },
    }
}

/**
 * App shortcuts that lite-monaco also binds (⌘T workspace symbol, ⌘⇧[ ] fold all): claimed here
 * so the editor leaves them alone, and the key goes on up to the window's handler (App.tsx). The
 * app's other shortcuts are not bound by the editor and pass through as they are.
 */
const APP_KEYS = ['Mod-t', 'Mod-Shift-[', 'Mod-Shift-]', 'Mod-Shift-{', 'Mod-Shift-}']

/**
 * An editor for the tab in `parent`, picking up the tab's last state (undo history, selection,
 * folds) when it had a view before. The view reports back to the tab: user edits schedule the
 * autosave, caret moves feed the status bar, leaving the editor saves.
 */
export function mountEditor(parent: HTMLElement, tab: FileTab, kit: EditorKit, dark: boolean): core.EditorView {
    const theme = dark ? DARK_THEME : LIGHT_THEME
    const view = litcode({
        parent,
        // Shiki types `lang` as its bundled-language union; lite-monaco passes the string it was given.
        highlighter: kit.hl as unknown as ShikiLike,
        lang: kit.lang,
        theme,
        colors: colorsFor(kit.hl, theme),
        fileName: tab.path,
        state: tab.state ?? undefined,
        doc: toLf(tab.base),
        keymap: [
            { key: 'Mod-s', run: () => {
                void tab.save('explicit')
                return true
            } },
            ...APP_KEYS.map(key => ({ key, run: () => true, preventDefault: false })),
        ],
    })
    tab.state = null
    tab.view = view
    tab.setLanguage(kit.languageName)

    const report = (state: core.EditorState) => {
        const { main } = state.selection
        const line = state.doc.lineAt(main.head)
        const selected = state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0)
        tab.setCursor(line.number, main.head - line.from + 1, selected)
    }
    report(view.state)
    const stop = view.onTransaction((t) => {
        if (t.docChanged && !t.annotation(core.Transaction.remote))
            tab.edited()
        if (t.docChanged || t.selection)
            report(view.state)
    })
    const onFocusOut = () => void tab.flush()
    view.contentDOM.addEventListener('focusout', onFocusOut)

    if (tab.scroll) {
        const { top, left } = tab.scroll
        requestAnimationFrame(() => {
            view.scrollDOM.scrollTop = top
            view.scrollDOM.scrollLeft = left
        })
    }

    const destroy = view.destroy.bind(view)
    view.destroy = () => {
        stop()
        view.contentDOM.removeEventListener('focusout', onFocusOut)
        tab.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }
        tab.state = view.state
        if (tab.view === view)
            tab.view = null
        destroy()
    }
    return view
}
