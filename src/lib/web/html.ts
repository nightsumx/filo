// HTML and Vue single-file components through vscode-html-languageservice: tags, attributes, values, paths, hovers and
// links in the markup; `<style>` blocks go to the CSS service, `<script>` blocks to TypeScript (session.ts). Vue adds its
// own tags, directives and the components a script imports.
import type { CompletionItem, DocumentContext, IAttributeData, IHTMLDataProvider, ITagData, LanguageService } from 'vscode-html-languageservice'
import type { CssLang } from './css'
import { getLanguageService, TokenType } from 'vscode-html-languageservice'
import { blocks } from '../vueSfc'
import { fromUri, provider, resolveRef, toUri } from './fsys'
import { textDocument } from './lsp'

export type MarkupLang = 'html' | 'vue'
export const MARKUP_LANGS = new Set<string>(['html', 'vue'])

/** Where an offset of a markup file is: the markup itself, or a block another language reads. */
export type Region =
    | { kind: 'markup' }
    | { kind: 'style', lang: CssLang, from: number, to: number }
    | { kind: 'script', ts: boolean, from: number, to: number }

export const cssLangOf = (lang: string | null): CssLang => lang === 'scss' || lang === 'sass' ? 'scss' : lang === 'less' ? 'less' : 'css'

export function regionAt(text: string, lang: MarkupLang, offset: number): Region {
    for (const b of blocks(text)) {
        if (offset < b.from || offset > b.to)
            continue
        if (b.tag === 'style')
            return { kind: 'style', lang: cssLangOf(b.lang), from: b.from, to: b.to }
        // A script that is not JavaScript or TypeScript (a template, JSON) is not ours to read.
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(b.attrs)?.[1]
        if (lang === 'html' && type && !/^(?:module|text\/javascript|application\/javascript|text\/typescript)$/i.test(type))
            return { kind: 'markup' }
        return { kind: 'script', ts: /^tsx?$/i.test(b.lang ?? ''), from: b.from, to: b.to }
    }
    return { kind: 'markup' }
}

// -- Vue's own tags, attributes and the components a script imports

const VUE_TAGS: ITagData[] = [
    { name: 'template', attributes: [] },
    { name: 'slot', description: 'A slot outlet.', attributes: [{ name: 'name' }] },
    { name: 'component', description: 'A dynamic component: `:is` names it.', attributes: [{ name: ':is' }] },
    { name: 'transition', description: 'Animates an element entering or leaving.', attributes: [{ name: 'name' }, { name: 'mode', values: [{ name: 'in-out' }, { name: 'out-in' }] }, { name: 'appear' }] },
    { name: 'transition-group', description: 'Animates a list.', attributes: [{ name: 'name' }, { name: 'tag' }] },
    { name: 'keep-alive', description: 'Keeps the components inside alive.', attributes: [{ name: 'include' }, { name: 'exclude' }, { name: 'max' }] },
    { name: 'teleport', description: 'Renders its content somewhere else in the DOM.', attributes: [{ name: 'to' }, { name: 'disabled' }] },
    { name: 'suspense', description: 'Waits for async dependencies of the components inside.', attributes: [] },
    { name: 'router-link', attributes: [{ name: 'to' }] },
    { name: 'router-view', attributes: [{ name: 'name' }] },
]

const DIRECTIVES: IAttributeData[] = [
    ['v-if', 'Renders the element if the expression is truthy.'],
    ['v-else-if', 'The `else if` block of `v-if`.'],
    ['v-else', 'The `else` block of `v-if`.'],
    ['v-for', 'Renders the element for each item: `item in items`.'],
    ['v-show', 'Toggles the element\'s `display`.'],
    ['v-model', 'Two-way binding on a form input or component.'],
    ['v-bind', 'Binds an attribute or a prop to an expression. Shorthand `:`.'],
    ['v-on', 'Listens to an event. Shorthand `@`.'],
    ['v-slot', 'Names a slot, and its props. Shorthand `#`.'],
    ['v-html', 'Sets the element\'s innerHTML.'],
    ['v-text', 'Sets the element\'s text content.'],
    ['v-once', 'Renders the element once.'],
    ['v-pre', 'Skips compiling the element.'],
    ['v-cloak', 'Stays until the component is compiled.'],
    ['v-memo', 'Memoizes a subtree on a list of values.'],
].map(([name, description]) => ({ name, description }))

const COMMON_BINDS = ['class', 'style', 'key', 'ref', 'is', 'id', 'src', 'href', 'value', 'disabled', 'checked', 'title', 'type', 'name', 'placeholder']
const COMMON_EVENTS = ['click', 'dblclick', 'input', 'change', 'submit', 'keydown', 'keyup', 'keypress', 'focus', 'blur', 'mouseenter', 'mouseleave', 'mousedown', 'mouseup', 'scroll', 'load', 'error']

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
export const pascal = (name: string) => name.replace(/(?:^|-)(\w)/g, (_, c: string) => c.toUpperCase())

/** `import Name from './Name.vue'` in the component's scripts. */
export function importedComponents(text: string): { name: string, spec: string, at: number }[] {
    const out: { name: string, spec: string, at: number }[] = []
    for (const b of blocks(text).filter(x => x.tag === 'script')) {
        const body = text.slice(b.from, b.to)
        for (const m of body.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/g))
            out.push({ name: m[1], spec: m[2], at: b.from + m.index + m[0].indexOf(m[1]) })
    }
    return out.filter(c => /\.vue$/.test(c.spec) || /^[A-Z]/.test(c.name))
}

let components: string[] = []
const vueData: IHTMLDataProvider = {
    getId: () => 'vue',
    isApplicable: id => id === 'vue',
    provideTags: () => [
        ...VUE_TAGS,
        ...components.flatMap(name => [{ name, description: 'Imported component.', attributes: [] }, { name: kebab(name), description: 'Imported component.', attributes: [] }]),
    ],
    provideAttributes: () => [
        ...DIRECTIVES,
        ...COMMON_BINDS.map(name => ({ name: `:${name}`, description: `Binds \`${name}\`.` })),
        ...COMMON_EVENTS.map(name => ({ name: `@${name}`, description: `Listens to \`${name}\`.` })),
        { name: '#default', description: 'The default slot.' },
    ],
    provideValues: () => [],
}

// -- class names, from the stylesheets the file uses

export interface ClassSource {
    /** The class names (`.a`) and ids (`#b`) the file's stylesheets define. */
    names: () => { class: string[], id: string[] }
}
let styles: ClassSource | null = null

let service: LanguageService | null = null
function html(): LanguageService {
    if (!service) {
        service = getLanguageService({ fileSystemProvider: provider(), customDataProviders: [vueData] })
        service.setCompletionParticipants([{
            onHtmlAttributeValue: (context: { attribute: string, range: import('vscode-html-languageservice').Range }) => {
                const kind = context.attribute === 'class' ? 'class' : context.attribute === 'id' ? 'id' : null
                if (!kind || !styles)
                    return
                // Collected into the list this call is building: the participant gets no list, so it is kept here.
                for (const name of styles.names()[kind])
                    pending.push({ label: name, kind: 20, detail: kind === 'class' ? 'class' : 'id' } as CompletionItem)
            },
        }])
    }
    return service
}
let pending: CompletionItem[] = []

export interface MarkupContext {
    path: string
    cwd: string
    lang: MarkupLang
    classes?: ClassSource
}

const contextOf = (ctx: MarkupContext): DocumentContext => ({
    resolveReference: (ref, base) => {
        // `/x` in a page is the project's root, as a dev server serves it.
        const path = ref.startsWith('/') && !ref.startsWith('//') ? resolveRef(`${ctx.cwd}/_`, ref.slice(1)) : resolveRef(fromUri(base), ref)
        return path ? toUri(path) : undefined
    },
})

function prepare(ctx: MarkupContext, text: string) {
    components = ctx.lang === 'vue' ? importedComponents(text).map(c => c.name) : []
    styles = ctx.classes ?? null
    pending = []
    const doc = textDocument(toUri(ctx.path), ctx.lang, text)
    return { doc, service: html(), parsed: html().parseHTMLDocument(doc) }
}

export async function markupComplete(ctx: MarkupContext, text: string, offset: number) {
    const { doc, service: s, parsed } = prepare(ctx, text)
    const list = await s.doComplete2(doc, doc.positionAt(offset), parsed, contextOf(ctx), { hideAutoCompleteProposals: true })
    return { doc, list: { ...list, items: [...list.items, ...pending] } }
}

export function markupHover(ctx: MarkupContext, text: string, offset: number) {
    const { doc, service: s, parsed } = prepare(ctx, text)
    return { doc, hover: s.doHover(doc, doc.positionAt(offset), parsed, { documentation: true, references: true }) }
}

/** `src` / `href` / `<style src>`: the text that names a file and where it leads. */
export function markupLinks(ctx: MarkupContext, text: string): { from: number, to: number, path: string }[] {
    const { doc, service: s } = prepare(ctx, text)
    const out: { from: number, to: number, path: string }[] = []
    for (const link of s.findDocumentLinks(doc, contextOf(ctx))) {
        if (link.target?.startsWith('file://'))
            out.push({ from: doc.offsetAt(link.range.start), to: doc.offsetAt(link.range.end), path: fromUri(link.target) })
    }
    // The service passes over a style block's `src`.
    for (const b of blocks(text).filter(x => x.tag === 'style' && x.src)) {
        const at = text.indexOf(b.src!, text.lastIndexOf('<style', b.from))
        const path = resolveRef(ctx.path, b.src!)
        if (path && at >= 0 && !out.some(l => l.from === at))
            out.push({ from: at, to: at + b.src!.length, path })
    }
    return out
}

/** What a token of the markup is: `tag` name, `class`/`id` word, an expression of a Vue template. */
export type Token =
    | { kind: 'tag', name: string, from: number, to: number }
    | { kind: 'class' | 'id', name: string, from: number, to: number }
    | { kind: 'expression', name: string, from: number, to: number }

const WORD = /[\w$-]/
const IDENT = /[\w$]/

export function tokenAt(ctx: MarkupContext, text: string, offset: number): Token | null {
    const { service: s } = prepare(ctx, text)
    const scanner = s.createScanner(text)
    let attr = ''
    for (let t = scanner.scan(); t !== TokenType.EOS; t = scanner.scan()) {
        const from = scanner.getTokenOffset()
        const to = scanner.getTokenEnd()
        if (t === TokenType.AttributeName)
            attr = scanner.getTokenText()
        if (from > offset)
            break
        if (offset < from || offset > to)
            continue
        if (t === TokenType.StartTag || t === TokenType.EndTag)
            return { kind: 'tag', name: scanner.getTokenText(), from, to }
        if (t === TokenType.AttributeValue) {
            const quoted = /^["']/.test(text[from])
            const inner = { from: from + (quoted ? 1 : 0), to: to - (quoted && /["']$/.test(text.slice(from + 1, to)) ? 1 : 0) }
            if (offset < inner.from || offset > inner.to)
                return null
            if (attr === 'class' || attr === 'id') {
                let a = offset
                let b = offset
                while (a > inner.from && WORD.test(text[a - 1]))
                    a--
                while (b < inner.to && WORD.test(text[b]))
                    b++
                return a < b ? { kind: attr, name: text.slice(a, b), from: a, to: b } : null
            }
            if (ctx.lang === 'vue' && /^(?:v-|[:@#])/.test(attr))
                return identifierAt(text, offset, inner.from, inner.to)
            return null
        }
    }
    if (ctx.lang === 'vue') {
        // {{ name }}
        const open = text.lastIndexOf('{{', offset)
        const close = text.indexOf('}}', Math.max(open, 0))
        if (open >= 0 && close >= offset && !text.slice(open, offset).includes('}}'))
            return identifierAt(text, offset, open + 2, close)
    }
    return null
}

function identifierAt(text: string, offset: number, min: number, max: number): Token | null {
    let a = offset
    let b = offset
    while (a > min && IDENT.test(text[a - 1]))
        a--
    while (b < max && IDENT.test(text[b]))
        b++
    // `a.b`: only the first name is the component's own; `.b` belongs to a.
    if (a === b || /\d/.test(text[a]) || text[a - 1] === '.' || (a > min && text[a - 1] === '?' && text[a - 2] === '.'))
        return null
    return { kind: 'expression', name: text.slice(a, b), from: a, to: b }
}

/** `<link rel="stylesheet" href>` and `<style src>`: the stylesheets a page names. */
export function stylesheetLinks(ctx: MarkupContext, text: string): string[] {
    const { service: s } = prepare(ctx, text)
    const scanner = s.createScanner(text)
    const out: string[] = []
    let tag = ''
    let attrs: Record<string, string> = {}
    for (let t = scanner.scan(); t !== TokenType.EOS; t = scanner.scan()) {
        if (t === TokenType.StartTag) {
            tag = scanner.getTokenText().toLowerCase()
            attrs = {}
        }
        else if (t === TokenType.AttributeName) {
            const name = scanner.getTokenText().toLowerCase()
            attrs[name] = ''
            const next = scanner.scan()
            if (next === TokenType.DelimiterAssign) {
                if (scanner.scan() === TokenType.AttributeValue)
                    attrs[name] = scanner.getTokenText().replace(/^["']|["']$/g, '')
            }
        }
        else if ((t === TokenType.StartTagClose || t === TokenType.StartTagSelfClose) && tag === 'link' && /stylesheet/i.test(attrs.rel ?? '') && attrs.href) {
            const path = contextOf(ctx).resolveReference(attrs.href, toUri(ctx.path))
            if (path)
                out.push(fromUri(path))
        }
    }
    return out
}

/** The position of the first rule that starts with `.name` / `#name` in a stylesheet's text. */
export function selectorAt(text: string, kind: 'class' | 'id', name: string): number | null {
    const escaped = name.replace(/[$()*+.?[\\\]^{|}-]/g, '\\$&')
    const re = new RegExp(`(^|[\\s,>+~{};(])\\${kind === 'class' ? '.' : '#'}${escaped}(?![\\w-])`, 'm')
    const m = re.exec(text)
    return m ? m.index + m[1].length : null
}

/** The names a stylesheet defines, for completion. */
export function selectorNames(text: string): { class: string[], id: string[] } {
    const classes = new Set<string>()
    const ids = new Set<string>()
    // Selectors only: what is before a `{`, without declarations' values (`1.5em`, `#fff`).
    for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{/g)) {
        for (const c of m[1].matchAll(/(?:^|[^\w-])\.(-?[A-Za-z_][\w-]*)/g))
            classes.add(c[1])
        for (const c of m[1].matchAll(/(?:^|[^\w-])#(-?[A-Za-z_][\w-]*)/g))
            ids.add(c[1])
    }
    return { class: [...classes].sort(), id: [...ids].sort() }
}
