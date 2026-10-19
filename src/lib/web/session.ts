// CSS, SCSS, Less, HTML and Vue in the editor: what lite-monaco shows (completion, hover, squiggles) and what the
// app adds (⌘-click and F12 into other files, ⌘-hover underline). One kit per open file. The services are in css.ts and
// html.ts; a `<script>` goes to the TypeScript service (tsEmbed.ts), a `<style>` to the CSS one on a copy of the file in
// which everything else is blank, so an offset is the same everywhere.
import type { ProjectLink } from '@/store/codeIntel'
import type { FileTab } from '@/store/fileTab'
import type { CssLang } from './css'
import type { Embedded } from './tsEmbed'
import type { CompletionItemM } from 'lite-monaco'
import { core, getTSService, registerCompletionItemProvider } from 'lite-monaco'
import { codeIntel } from '@/store/codeIntel'
import { blank, blocks, vueScript, vueTail } from '../vueSfc'
import { cssComplete, cssDefinition, cssHover, cssLinks, cssValidate } from './css'
import { dirname, resolveRef, webFs } from './fsys'
import type { MarkupContext } from './html'
import { cssLangOf, importedComponents, markupComplete, markupHover, markupLinks, pascal, regionAt, selectorAt, selectorNames, stylesheetLinks, tokenAt } from './html'
import { renderCard, toCompletionItems, toHoverCard, toSquiggles } from './lsp'
import { tsComplete, tsDeclaration, tsDefinition, tsHover, tsSpan } from './tsEmbed'

export const WEB_LANGS = new Set(['css', 'scss', 'less', 'html', 'vue'])
const CSS_LANGS = new Set(['css', 'scss', 'less'])

export interface Place {
    path: string
    line: number
    col: number
}

export interface WebKit {
    lang: string
    /** What the TypeScript service reads in place of the file (a component's or page's script); null for a stylesheet. */
    embedded: Embedded | null
    /** The markup services' view of the file: where it is, and the class names its stylesheets define. */
    context: () => MarkupContext
    /** The hover for the editor's `hoverSources`. */
    hover: core.HoverSource
    /** Where Go to Definition at `pos` leads, and the text it acts on (underlined with ⌘ held). */
    resolve: (text: string, pos: number) => { span: { from: number, to: number }, to: Place } | null
    /** Completion at `offset`, in whichever language is there. */
    complete: (text: string, offset: number) => Promise<{ items: CompletionItemM[], incomplete: boolean }>
    /** The squiggles for the text. */
    diagnose: (text: string) => Promise<core.Diagnostic[]>
    /** Starts the squiggles and the reading of the files the markup names; returns the stop. */
    start: (view: core.EditorView) => () => void
}

const kits = new Map<string, WebKit>()

const OWN_SOURCES = new Set(['css', 'html', 'vue-ts'])

function lineCol(text: string, offset: number): { line: number, col: number } {
    const before = text.slice(0, offset)
    return { line: before.split('\n').length, col: offset - (before.lastIndexOf('\n') + 1) + 1 }
}

const wordAround = (text: string, pos: number, word: RegExp): { from: number, to: number } | null => {
    let a = pos
    let b = pos
    while (a > 0 && word.test(text[a - 1]))
        a--
    while (b < text.length && word.test(text[b]))
        b++
    return a < b ? { from: a, to: b } : null
}

/** What the TypeScript service reads in place of this file; null when it has no script. */
export function embeddedOf(tab: Pick<FileTab, 'path' | 'cwd'>, lang: string): Embedded | null {
    if (lang === 'vue')
        return { path: `${tab.path}.ts`, cwd: tab.cwd, family: 'typescript', code: text => vueScript(text).code }
    if (lang === 'html')
        return { path: `${tab.path}.js`, cwd: tab.cwd, family: 'javascript', code: text => blank(text, blocks(text).filter(b => b.tag === 'script' && !b.src)) }
    return null
}

/**
 * The project link for a component's or page's script: the service is given the script as a file of its own, and
 * the editor's text is turned into it on the way in. Null when the file has none.
 */
export async function embeddedLink(tab: FileTab, lang: string, level: 'standard' | 'full', text: string): Promise<ProjectLink | null> {
    const at = embeddedOf(tab, lang)
    if (!at || (lang === 'html' && !/<script\b/i.test(text)))
        return null
    const link = await codeIntel.attach(at, at.family, level, at.code(text))
    // No TypeScript editor of its own brings the service up here.
    await getTSService({ lang: at.family, fileName: at.path }).ensure().catch(() => null)
    return {
        sync: next => link.sync(at.code(next)),
        check: async (req) => {
            const code = at.code(req.text)
            const tail = vueTail(code)
            // JavaScript in a component is read for its types, not reported on; what we added past its end is not the user's.
            if (!tail?.ts)
                return null
            const result = await link.check({ ...req, fileName: at.path.startsWith('/') ? at.path : `/${at.path}`, text: code })
            return result ? { ...result, diagnostics: result.diagnostics.filter(d => d.from < tail.end), tags: [] } : null
        },
        release: () => link.release(),
    }
}

interface Sheet {
    /** Where its text lives: a file, or this file (a `<style>` block). */
    path: string
    text: string
    /** Offset of the text in its file. */
    base: number
}

export function webKit(tab: FileTab, lang: string, project: ProjectLink | null): WebKit | null {
    if (!WEB_LANGS.has(lang))
        return null
    const path = tab.path
    const markup = lang === 'html' || lang === 'vue'
    const embedded = embeddedOf(tab, lang)
    let current = tab.state?.doc.toString() ?? ''
    /** Linked stylesheets, read; and which files exist in the folders links lead to. */
    const linked = new Map<string, string>()
    const listed = new Map<string, Set<string>>()

    const inline = (text: string): Sheet[] => blocks(text).filter(b => b.tag === 'style' && !b.src).map(b => ({ path, text: text.slice(b.from, b.to), base: b.from }))
    const sheets = (text: string): Sheet[] => [...inline(text), ...[...linked].map(([p, t]) => ({ path: p, text: t, base: 0 }))]
    const ctx = (): MarkupContext => ({
        path,
        cwd: tab.cwd,
        lang: lang as 'html' | 'vue',
        classes: { names: () => {
            const all = sheets(current).map(s => selectorNames(s.text))
            return { class: [...new Set(all.flatMap(a => a.class))].sort(), id: [...new Set(all.flatMap(a => a.id))].sort() }
        } },
    })

    const exists = (target: string) => listed.get(dirname(target))?.has(target.slice(target.lastIndexOf('/') + 1)) ?? false
    /** The file a link leads to: a Sass import may leave off the extension and the underscore. */
    const file = (target: string): string | null => {
        if (exists(target))
            return target
        const dir = dirname(target)
        const name = target.slice(target.lastIndexOf('/') + 1)
        for (const candidate of [`${name}.scss`, `_${name}.scss`, `${name}.sass`, `_${name}.sass`, `${name}.less`, `${name}.css`]) {
            if (listed.get(dir)?.has(candidate))
                return `${dir}/${candidate}`
        }
        return null
    }

    const stylesheetPaths = (text: string): string[] => {
        const out = [...stylesheetLinks(ctx(), text)]
        if (lang === 'vue') {
            for (const b of blocks(text)) {
                if (b.tag === 'style' && b.src) {
                    const p = resolveRef(path, b.src)
                    if (p)
                        out.push(p)
                }
                if (b.tag === 'script') {
                    for (const m of text.slice(b.from, b.to).matchAll(/\bimport\s+['"]([^'"]+\.(?:css|scss|less))['"]/g)) {
                        const p = resolveRef(path, m[1])
                        if (p)
                            out.push(p)
                    }
                }
            }
        }
        return out
    }

    /** Reads what the file names: the stylesheets (their text) and the folders its links lead into. */
    let priming = 0
    const prime = async (text: string) => {
        const run = ++priming
        const targets = new Set<string>(stylesheetPaths(text))
        const links = markup ? markupLinks(ctx(), text) : CSS_LANGS.has(lang) ? cssLinks(path, lang as CssLang, text) : []
        for (const l of links)
            targets.add(l.path)
        const dirs = new Set([...targets].map(dirname))
        await Promise.all([...dirs].map(async (d) => {
            const list = await webFs().list(d)
            if (list)
                listed.set(d, new Set(list.map(e => e.name)))
        }))
        const next = new Map<string, string>()
        await Promise.all(stylesheetPaths(text).map(async (p) => {
            const body = await webFs().read(p)
            if (body !== null)
                next.set(p, body)
        }))
        if (run !== priming)
            return
        linked.clear()
        for (const [p, t] of next)
            linked.set(p, t)
    }

    /** The place of a rule for a class or id: this file's own blocks, then the linked sheets. */
    const ruleFor = (text: string, kind: 'class' | 'id', name: string): Place | null => {
        for (const s of sheets(text)) {
            const at = selectorAt(s.text, kind, name)
            if (at !== null) {
                const whole = s.path === path ? text : s.text
                return { path: s.path, ...lineCol(whole, s.base + at) }
            }
        }
        return null
    }

    const styleLang = (text: string, pos: number): { lang: CssLang, text: string } | null => {
        if (CSS_LANGS.has(lang))
            return { lang: lang as CssLang, text }
        const region = regionAt(text, lang as 'html' | 'vue', pos)
        return region.kind === 'style' ? { lang: region.lang, text: blank(text, [region]) } : null
    }

    const resolve: WebKit['resolve'] = (text, pos) => {
        current = text
        // A style block, or a stylesheet.
        const css = styleLang(text, pos)
        if (css) {
            for (const link of cssLinks(path, css.lang, css.text)) {
                const to = file(link.path)
                const quoted = /["']/.test(text[link.from]) ? 1 : 0
                if (to && pos >= link.from && pos <= link.to)
                    return { span: { from: link.from + quoted, to: link.to - quoted }, to: { path: to, line: 1, col: 1 } }
            }
            const word = wordAround(text, pos, /[\w$-]/)
            const found = word && cssDefinition(path, css.lang, css.text, pos)
            return word && found ? { span: word, to: { path, ...lineCol(text, found.at) } } : null
        }
        const region = regionAt(text, lang as 'html' | 'vue', pos)
        if (region.kind === 'script' && embedded) {
            const span = tsSpan(embedded, text, pos)
            const to = span && tsDefinition(embedded, path, text, pos)
            return span && to ? { span, to } : null
        }
        for (const link of markupLinks(ctx(), text)) {
            const to = file(link.path)
            if (to && pos >= link.from && pos <= link.to)
                return { span: { from: link.from, to: link.to }, to: { path: to, line: 1, col: 1 } }
        }
        const token = tokenAt(ctx(), text, pos)
        if (!token)
            return null
        if (token.kind === 'class' || token.kind === 'id') {
            const to = ruleFor(text, token.kind, token.name)
            return to ? { span: token, to } : null
        }
        if (!embedded || lang !== 'vue')
            return null
        if (token.kind === 'tag') {
            const comp = importedComponents(text).find(c => c.name === token.name || c.name === pascal(token.name))
            const to = comp && tsDefinition(embedded, path, text, comp.at)
            return comp && to ? { span: token, to } : null
        }
        const at = tsDeclaration(embedded, text, token.name)
        return at === null ? null : { span: token, to: { path, ...lineCol(text, at) } }
    }

    const hover: core.HoverSource = async (state, pos) => {
        const text = state.doc.toString()
        current = text
        let card: { from: number, to: number, markdown: string } | null = null
        const css = styleLang(text, pos)
        if (css) {
            const { doc, hover: h } = cssHover(path, css.lang, css.text, pos)
            card = toHoverCard(doc, h, pos)
        }
        else {
            const region = regionAt(text, lang as 'html' | 'vue', pos)
            if (region.kind === 'script')
                card = embedded ? tsHover(embedded, text, pos) : null
            else {
                const { doc, hover: h } = markupHover(ctx(), text, pos)
                card = toHoverCard(doc, h, pos)
            }
        }
        return card ? { pos: card.from, end: card.to, create: () => renderCard(card.markdown) } : null
    }

    const complete: WebKit['complete'] = async (text, offset) => {
        current = text
        const css = styleLang(text, offset)
        if (css) {
            const { doc, list } = await cssComplete(path, css.lang, css.text, offset)
            return { items: toCompletionItems(doc, list), incomplete: !!list.isIncomplete }
        }
        if (regionAt(text, lang as 'html' | 'vue', offset).kind === 'script')
            return { items: embedded ? tsComplete(embedded, text, offset) : [], incomplete: false }
        const { doc, list } = await markupComplete(ctx(), text, offset)
        return { items: toCompletionItems(doc, list), incomplete: !!list.isIncomplete }
    }

    const squiggles = async (text: string): Promise<core.Diagnostic[]> => {
        const out: core.Diagnostic[] = []
        const add = (doc: Parameters<typeof toSquiggles>[0], diagnostics: Parameters<typeof toSquiggles>[1], source: string) => {
            for (const s of toSquiggles(doc, diagnostics, source))
                out.push(s)
        }
        if (CSS_LANGS.has(lang)) {
            const r = cssValidate(path, lang as CssLang, text)
            add(r.doc, r.diagnostics, 'css')
            return out
        }
        for (const b of blocks(text).filter(x => x.tag === 'style' && !x.src)) {
            const r = cssValidate(path, cssLangOf(b.lang), blank(text, [b]))
            add(r.doc, r.diagnostics, 'css')
        }
        if (lang === 'vue' && project) {
            const result = await project.check({ fileName: path, text, mode: 'full', wantTags: false, options: {} }).catch(() => null)
            for (const d of result?.diagnostics ?? [])
                out.push({ from: d.from, to: d.to, severity: d.severity, message: d.message, code: d.code, source: 'vue-ts', related: d.related })
        }
        return out
    }

    const start = (view: core.EditorView) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let run = 0
        let alive = true
        const refresh = async () => {
            const mine = ++run
            const text = view.state.doc.toString()
            current = text
            const [found] = await Promise.all([squiggles(text), prime(text)])
            if (!alive || mine !== run)
                return
            const kept = (view.state.field(core.diagnosticsField, false) ?? []).filter(d => !OWN_SOURCES.has(d.source ?? ''))
            view.dispatch(view.state.update({ effects: core.setDiagnostics.of([...kept, ...found]) }))
        }
        void refresh()
        const stop = view.onTransaction((t) => {
            if (!t.docChanged)
                return
            clearTimeout(timer)
            timer = setTimeout(() => void refresh(), 500)
        })
        return () => {
            alive = false
            clearTimeout(timer)
            stop()
        }
    }

    const kit: WebKit = { lang, embedded, context: ctx, hover, resolve, complete, diagnose: squiggles, start: view => {
        // Completion asks for the kit of the file it is in: it is there while the editor is.
        kits.set(path, kit)
        const stop = start(view)
        return () => {
            stop()
            if (kits.get(path) === kit)
                kits.delete(path)
        }
    } }
    const first = tab.state?.doc.toString() ?? ''
    if (first)
        void prime(first)
    return kit
}

export const webExtensions = (kit: WebKit) => [core.hoverSources.of(kit.hover)]

// -- completion: asked through lite-monaco's provider registry, by the file the editor is for

let installed = false
export function installWebProviders() {
    if (installed)
        return
    installed = true
    const ask = async (model: { uri: { toString: () => string }, getValue: () => string, getOffsetAt: (p: { lineNumber: number, column: number }) => number }, position: { lineNumber: number, column: number }) => {
        const kit = kits.get(model.uri.toString())
        if (!kit)
            return null
        const { items, incomplete } = await kit.complete(model.getValue(), model.getOffsetAt(position))
        return { suggestions: items, incomplete }
    }
    registerCompletionItemProvider(['css', 'scss', 'less'], { triggerCharacters: [':', '$', '@', '-', '(', '/', '"', '\'', ','], provideCompletionItems: ask })
    registerCompletionItemProvider(['html', 'vue'], { triggerCharacters: ['<', '/', ' ', '=', '"', '\'', ':', '@', '.', '#', '-'], provideCompletionItems: ask })
}
