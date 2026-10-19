// lite-monaco (litcode) for the editor tabs: one Shiki highlighter for the app, languages loaded as
// files need them, colours from a VS Code theme with the app's own editor background, the
// TypeScript standard library bundled with the app instead of fetched from a CDN (src/lib/tsLibs.ts),
// and the squiggles computed in a worker (src/lib/tsCheck.ts).
import type { EditorIntel } from '@shared/ipc'
import type { Highlighter } from 'shiki'
import type { LitCodeFeatures, ShikiLike, ThemeColors } from 'lite-monaco'
import type { FileTab } from '@/store/fileTab'
import type { ProjectLink } from '@/store/codeIntel'
import { core, litcode } from 'lite-monaco'
import { bundledLanguagesInfo, createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { tr } from '@/lib/i18n'
import { toLf } from '@/lib/textEdit'
import { installTsLibs } from '@/lib/tsLibs'
import { embeddedLink, embeddedOf, installWebProviders, webExtensions, webKit, WEB_LANGS } from '@/lib/web/session'
import type { WebKit } from '@/lib/web/session'
import { appStore } from '@/store/app'
import { codeIntel } from '@/store/codeIntel'
import { fileKey } from '@/store/fileTab'

/** VS Code's own defaults, so a file reads the same here as in VS Code (the transcript's code blocks keep highlight.js's GitHub colours). */
export const DARK_THEME = 'dark-plus'
export const LIGHT_THEME = 'light-plus'

installTsLibs()
installWebProviders()

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

const TS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx'])

/** No TypeScript service at all: highlighting and editing only (Settings → Editor → Light). */
const LIGHT_FEATURES: LitCodeFeatures = {
    tsDiagnostics: false,
    signatureHelp: false,
    codeActions: false,
    autocomplete: false,
    hover: false,
    stickyScroll: false,
    inlayHints: false,
    tsUnusedFade: false,
}

/** The name or path under the pointer while ⌘ (Ctrl) is held and there is somewhere to go: underlined and made a link. */
const setLink = core.StateEffect.define<{ from: number, to: number } | null>()
const linkField = core.StateField.define<{ from: number, to: number } | null>({
    create: () => null,
    update: (value, tr) => {
        for (const effect of tr.effects) {
            if (effect.is(setLink))
                return effect.value
        }
        return value && tr.docChanged ? null : value
    },
})
const linkMark = core.Decoration.mark({ class: 'cm-def-link' })
const linkDecorations = core.decorations.of((state) => {
    const link = state.field(linkField, false)
    return link && link.from < link.to && link.to <= state.doc.length ? core.RangeSet.of([linkMark.range(link.from, link.to)]) : core.RangeSet.empty
})

export interface EditorKit {
    hl: Highlighter
    /** Shiki id, loaded; 'text' when there is none. */
    lang: string
    /** For the status bar. */
    languageName: string
    level: EditorIntel
    /** What the TypeScript service gets of the project around the file; null when it gets none (light level, other languages). */
    project: ProjectLink | null
    /** CSS, HTML and Vue: completion, hover, squiggles and jumps (src/lib/web). */
    web?: WebKit | null
}

/** A link that works from the start and is wired to the real one when it arrives (or let go of at once if it was released first). */
export function lazyLink(attached: Promise<ProjectLink | null>): ProjectLink {
    let real: ProjectLink | null = null
    let released = false
    void attached.then((link) => {
        if (!link)
            return
        if (released)
            link.release()
        else
            real = link
    })
    return {
        sync: async (text) => {
            await (real ?? (await attached))?.sync(text)
        },
        check: async req => (await (real ?? (await attached)))?.check(req) ?? null,
        release: () => {
            released = true
            real?.release()
        },
    }
}

/** The highlighter with the file's language in it (lite-monaco does not load languages itself). */
export async function prepare(tab: FileTab, level: EditorIntel): Promise<EditorKit> {
    const hl = await highlighter()
    const language = languageOf(tab.name)
    if (language) {
        try {
            await hl.loadLanguage(language.id as Parameters<Highlighter['loadLanguage']>[0])
            let project: ProjectLink | null = null
            if (level !== 'light' && TS_LANGS.has(language.id)) {
                // Squiggles under every import would flash before the files arrive: wait a moment for them, not for the whole read.
                const attached = codeIntel.attach(tab, language.id, level, tab.state?.doc.toString() ?? toLf(tab.base)).catch(() => null)
                project = lazyLink(attached)
                await Promise.race([attached, new Promise(resolve => setTimeout(resolve, 500))])
            }
            let web: WebKit | null = null
            if (level !== 'light' && WEB_LANGS.has(language.id)) {
                // A component's script goes to the TypeScript service as a file of its own; a page's too.
                const text = tab.state?.doc.toString() ?? toLf(tab.base)
                // A stylesheet has no script, so no project.
                const attached = embeddedOf(tab, language.id) ? embeddedLink(tab, language.id, level, text).catch(() => null) : null
                if (attached) {
                    project = lazyLink(attached)
                    await Promise.race([attached, new Promise(resolve => setTimeout(resolve, 500))])
                }
                web = webKit(tab, language.id, project)
            }
            return { hl, lang: language.id, languageName: language.name, level, project, web }
        }
        catch {}
    }
    return { hl, lang: 'text', languageName: tr('纯文本', 'Plain text'), level, project: null }
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
    // Go to definition into another file opens that file in a tab; lite-monaco would show a preview only.
    // Within the file it is lite-monaco's (this returns false and the key or click goes on to it).
    const web = kit.level !== 'light' ? kit.web ?? null : null
    const jumps = kit.level !== 'light' && (TS_LANGS.has(kit.lang) || web !== null)
    let view!: core.EditorView
    const target = (pos: number) => web ? web.resolve(view.state.doc.toString(), pos)?.to ?? null : jumps ? codeIntel.definitionElsewhere(tab, kit.lang, view.state.doc.toString(), pos) : null
    const go = (to: NonNullable<ReturnType<typeof target>>) => {
        appStore.openFile(to.path, tab.cwd)
        appStore.files.get(fileKey(to.path))?.goto(to.line, to.col)
    }
    const jump = (pos: number): boolean => {
        const to = target(pos)
        if (!to)
            return false
        go(to)
        return true
    }
    view = litcode({
        parent,
        // Shiki types `lang` as its bundled-language union; lite-monaco passes the string it was given.
        highlighter: kit.hl as unknown as ShikiLike,
        lang: kit.lang,
        theme,
        colors: colorsFor(kit.hl, theme),
        // The tab's size follows the pane; lite-monaco defaults to Monaco's false and expects layout() calls.
        options: { automaticLayout: true },
        fileName: tab.path,
        // The type check runs in a worker, once the project is indexed; the squiggles come back from there.
        tsDiagnosticsRemote: kit.project ? req => kit.project?.check(req) ?? Promise.resolve(null) : undefined,
        features: kit.level === 'light' ? LIGHT_FEATURES : undefined,
        extensions: jumps ? [linkField, linkDecorations, ...(web ? webExtensions(web) : [])] : undefined,
        state: tab.state ?? undefined,
        doc: toLf(tab.base),
        keymap: [
            { key: 'F12', run: v => jump(v.state.selection.main.head) },
            { key: 'Mod-s', run: () => {
                void tab.save('explicit')
                return true
            } },
            ...APP_KEYS.map(key => ({ key, run: () => true, preventDefault: false })),
        ],
    })
    // The state carries the last level's squiggles along, and no session is left to take them away.
    if (kit.level === 'light' && view.state.field(core.diagnosticsField, false)?.length)
        view.dispatch(view.state.update({ effects: core.setDiagnostics.of([]) }))
    tab.state = null
    tab.view = view
    tab.setLanguage(kit.languageName)
    requestAnimationFrame(() => tab.applyReveal())

    // ⌘-click (Ctrl-click) on a name defined in another file.
    const onMouseDown = (e: MouseEvent) => {
        if (!jumps || e.button !== 0 || e.detail > 1 || e.shiftKey || e.altKey || !(core.browser.mac ? e.metaKey : e.ctrlKey))
            return
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
        const to = pos == null ? null : target(pos)
        if (!to)
            return
        e.preventDefault()
        e.stopImmediatePropagation()
        const up = (u: MouseEvent) => {
            document.removeEventListener('mouseup', up, true)
            if (Math.hypot(u.clientX - e.clientX, u.clientY - e.clientY) <= 4)
                go(to)
        }
        document.addEventListener('mouseup', up, true)
    }
    view.dom.addEventListener('mousedown', onMouseDown, true)

    // While ⌘ (Ctrl) is held the name or path under the pointer is underlined when it leads somewhere, as in WebStorm.
    const held = (e: { metaKey: boolean, ctrlKey: boolean }) => (core.browser.mac ? e.metaKey : e.ctrlKey)
    let point: { x: number, y: number } | null = null
    let modifier = false
    let frame = 0
    let shown: { from: number, to: number } | null = null
    let looked = { state: null as core.EditorState | null, at: -1 }
    const show = (link: { from: number, to: number } | null) => {
        if (link?.from === shown?.from && link?.to === shown?.to)
            return
        shown = link
        view.dispatch(view.state.update({ effects: setLink.of(link) }))
    }
    const look = () => {
        frame = 0
        if (!jumps || !modifier || !point)
            return show(null)
        const pos = view.posAtCoords(point)
        if (pos == null)
            return show(null)
        // posAtCoords rounds to the nearest boundary: the character under the pointer is the one before it when the pointer is left of it.
        const edge = view.caretCoords(pos)
        const at = edge && point.x < edge.left ? pos - 1 : pos
        if (at < 0 || at >= view.state.doc.length)
            return show(null)
        if (shown && at >= shown.from && at < shown.to && looked.state === view.state)
            return
        if (looked.state === view.state && looked.at === at)
            return
        looked = { state: view.state, at }
        const text = view.state.doc.toString()
        const span = web ? web.resolve(text, at)?.span ?? null : codeIntel.definitionSpan(tab, kit.lang, text, at)
        show(span && at >= span.from && at < span.to ? span : null)
    }
    const schedule = () => {
        if (!frame)
            frame = requestAnimationFrame(look)
    }
    const onMouseMove = (e: MouseEvent) => {
        point = { x: e.clientX, y: e.clientY }
        modifier = held(e) && e.buttons === 0
        if (modifier || shown)
            schedule()
    }
    const onKey = (e: KeyboardEvent) => {
        const next = held(e)
        if (next === modifier)
            return
        modifier = next
        schedule()
    }
    const onLeave = () => {
        point = null
        schedule()
    }
    if (jumps) {
        view.dom.addEventListener('mousemove', onMouseMove, true)
        view.dom.addEventListener('mouseleave', onLeave)
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('keyup', onKey, true)
        window.addEventListener('blur', onLeave)
    }

    const report = (state: core.EditorState) => {
        const { main } = state.selection
        const line = state.doc.lineAt(main.head)
        const selected = state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0)
        tab.setCursor(line.number, main.head - line.from + 1, selected)
    }
    report(view.state)
    const stopWeb = web?.start(view)
    const stop = view.onTransaction((t) => {
        if (t.docChanged && !t.annotation(core.Transaction.remote))
            tab.edited()
        if (t.docChanged || t.selection)
            report(view.state)
    })
    // New imports typed in a while ago are picked up; one load at a time is enough for the pause between edits.
    let resync: ReturnType<typeof setTimeout> | undefined
    const stopSync = kit.project
        ? view.onTransaction((t) => {
            if (!t.docChanged)
                return
            clearTimeout(resync)
            resync = setTimeout(() => void kit.project?.sync(view.state.doc.toString()), 1500)
        })
        : null
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
        stopWeb?.()
        stopSync?.()
        clearTimeout(resync)
        view.contentDOM.removeEventListener('focusout', onFocusOut)
        view.dom.removeEventListener('mousedown', onMouseDown, true)
        cancelAnimationFrame(frame)
        view.dom.removeEventListener('mousemove', onMouseMove, true)
        view.dom.removeEventListener('mouseleave', onLeave)
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('keyup', onKey, true)
        window.removeEventListener('blur', onLeave)
        tab.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }
        tab.state = view.state
        if (tab.view === view)
            tab.view = null
        destroy()
    }
    return view
}
