// CSS, SCSS and Less through vscode-css-languageservice: completion, hover, validation, links, same-file definitions.
// Every function takes the document's text; positions are offsets, as in the editor.
import type { DocumentContext, LanguageService } from 'vscode-css-languageservice'
import { getCSSLanguageService, getLESSLanguageService, getSCSSLanguageService } from 'vscode-css-languageservice'
import { fromUri, provider, resolveRef, toUri } from './fsys'
import { textDocument } from './lsp'

export type CssLang = 'css' | 'scss' | 'less'
export const CSS_LANGS = new Set<string>(['css', 'scss', 'less'])

const services = new Map<CssLang, LanguageService>()
function service(lang: CssLang): LanguageService {
    let hit = services.get(lang)
    if (!hit) {
        const options = { fileSystemProvider: provider() }
        hit = lang === 'scss' ? getSCSSLanguageService(options) : lang === 'less' ? getLESSLanguageService(options) : getCSSLanguageService(options)
        services.set(lang, hit)
    }
    return hit
}

const context = (): DocumentContext => ({
    resolveReference: (ref, base) => {
        const path = resolveRef(fromUri(base), ref)
        return path ? toUri(path) : undefined
    },
})

/** A document for `text`, as the file `path` (the language comes from the caller, not the name). */
export function cssDoc(path: string, lang: CssLang, text: string) {
    return textDocument(toUri(path), lang, text)
}

export async function cssComplete(path: string, lang: CssLang, text: string, offset: number) {
    const doc = cssDoc(path, lang, text)
    const s = service(lang)
    const list = await s.doComplete2(doc, doc.positionAt(offset), s.parseStylesheet(doc), context())
    return { doc, list }
}

export function cssHover(path: string, lang: CssLang, text: string, offset: number) {
    const doc = cssDoc(path, lang, text)
    const s = service(lang)
    return { doc, hover: s.doHover(doc, doc.positionAt(offset), s.parseStylesheet(doc), { documentation: true, references: true }) }
}

export function cssValidate(path: string, lang: CssLang, text: string) {
    const doc = cssDoc(path, lang, text)
    const s = service(lang)
    return { doc, diagnostics: s.doValidation(doc, s.parseStylesheet(doc)) }
}

/** The declaration of the variable, mixin, function or keyframes under `offset` in the same document. */
export function cssDefinition(path: string, lang: CssLang, text: string, offset: number): { from: number, to: number, at: number } | null {
    const doc = cssDoc(path, lang, text)
    const s = service(lang)
    const sheet = s.parseStylesheet(doc)
    const found = s.findDefinition(doc, doc.positionAt(offset), sheet)
    if (!found)
        return null
    const from = doc.offsetAt(found.range.start)
    const to = doc.offsetAt(found.range.end)
    return from <= offset && offset < to ? null : { from, to, at: from }
}

/** `@import "x"`, `@use`, `url(...)`: where each leads, as offsets of the text that names it and an absolute path. */
export function cssLinks(path: string, lang: CssLang, text: string): { from: number, to: number, path: string }[] {
    const doc = cssDoc(path, lang, text)
    const s = service(lang)
    const out: { from: number, to: number, path: string }[] = []
    for (const link of s.findDocumentLinks(doc, s.parseStylesheet(doc), context())) {
        if (!link.target?.startsWith('file://'))
            continue
        out.push({ from: doc.offsetAt(link.range.start), to: doc.offsetAt(link.range.end), path: fromUri(link.target) })
    }
    return out
}

/** Selectors of the stylesheet with where each starts: the targets of a class or id used in markup. */
export function cssSelectors(path: string, lang: CssLang, text: string): { name: string, at: number }[] {
    const doc = cssDoc(path, lang, text)
    const s = service(lang)
    const out: { name: string, at: number }[] = []
    const walk = (symbols: ReturnType<LanguageService['findDocumentSymbols2']>) => {
        for (const sym of symbols) {
            out.push({ name: sym.name, at: doc.offsetAt(sym.selectionRange.start) })
            if (sym.children)
                walk(sym.children)
        }
    }
    walk(s.findDocumentSymbols2(doc, s.parseStylesheet(doc)))
    return out
}
