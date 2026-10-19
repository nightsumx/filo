// Glue between the VS Code language services (CSS, HTML; LSP types) and lite-monaco's editor:
// completion items to Monaco's shape, hovers to a small DOM card, diagnostics to the editor's squiggles.
import type { CompletionItemM, IRange } from 'lite-monaco'
import type { CompletionItem, CompletionList, Diagnostic, Hover, MarkedString, MarkupContent, Range } from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'

export { TextDocument }

/** A document for the services: they want line tables and versions, we have a string. */
export function textDocument(uri: string, languageId: string, text: string, version = 1): TextDocument {
    return TextDocument.create(uri, languageId, version, text)
}

/** LSP CompletionItemKind (1-25) → Monaco's (0-27). */
const KIND: Record<number, number> = {
    1: 18, 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 7, 9: 8, 10: 9, 11: 12, 12: 13, 13: 15, 14: 17, 15: 27, 16: 19, 17: 20,
    18: 21, 19: 23, 20: 16, 21: 14, 22: 6, 23: 10, 24: 11, 25: 24,
}

export const toMonacoRange = (doc: TextDocument, range: Range): IRange => ({
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
})

export function markdownOf(value: string | MarkupContent | MarkedString | MarkedString[] | undefined): string {
    if (value === undefined)
        return ''
    if (Array.isArray(value))
        return value.map(v => markdownOf(v)).filter(Boolean).join('\n\n')
    if (typeof value === 'string')
        return value
    if ('kind' in value)
        return value.kind === 'plaintext' ? value.value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&') : value.value
    // { language, value }: a code block
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

export function toCompletionItems(doc: TextDocument, list: CompletionList | CompletionItem[] | null | undefined): CompletionItemM[] {
    const items = Array.isArray(list) ? list : list?.items ?? []
    return items.map((item): CompletionItemM => {
        const edit = item.textEdit
        const range = edit ? ('range' in edit ? edit.range : edit.replace) : undefined
        const documentation = markdownOf(item.documentation)
        return {
            label: item.label,
            kind: KIND[item.kind ?? 1] ?? 18,
            detail: item.detail,
            documentation: documentation ? { value: documentation } : undefined,
            sortText: item.sortText,
            filterText: item.filterText,
            preselect: item.preselect,
            insertText: edit?.newText ?? item.insertText ?? item.label,
            insertTextRules: item.insertTextFormat === 2 ? 4 : undefined,
            range: range ? toMonacoRange(doc, range) : undefined,
            commitCharacters: item.commitCharacters,
            tags: item.tags?.includes(1) ? [1] : undefined,
            additionalTextEdits: item.additionalTextEdits?.map(e => ({ range: toMonacoRange(doc, e.range), text: e.newText })),
        }
    })
}

export interface Squiggle {
    from: number
    to: number
    severity: 'error' | 'warning' | 'info'
    message: string
    code?: string
    source: string
}

const SEVERITY = ['error', 'error', 'warning', 'info', 'info'] as const

export function toSquiggles(doc: TextDocument, diagnostics: readonly Diagnostic[], source: string): Squiggle[] {
    return diagnostics.map((d) => {
        const from = doc.offsetAt(d.range.start)
        const to = Math.max(doc.offsetAt(d.range.end), from + 1)
        return {
            from,
            to: Math.min(to, doc.getText().length),
            severity: SEVERITY[d.severity ?? 1],
            message: d.message,
            code: d.code === undefined ? undefined : String(d.code),
            source,
        }
    }).filter(s => s.to > s.from)
}

export interface HoverCard {
    from: number
    to: number
    markdown: string
}

export function toHoverCard(doc: TextDocument, hover: Hover | null | undefined, at: number): HoverCard | null {
    const markdown = markdownOf(hover?.contents).trim()
    if (!hover || !markdown)
        return null
    const from = hover.range ? doc.offsetAt(hover.range.start) : at
    const to = hover.range ? doc.offsetAt(hover.range.end) : at
    return { from, to, markdown }
}

/** The card's DOM: fenced blocks as code, `inline code`, links as text, paragraphs. No HTML from the source is ever inserted as markup. */
export function renderCard(markdown: string): HTMLElement {
    const root = document.createElement('div')
    root.style.cssText = 'max-width:520px;padding:6px 10px;font-size:12px;line-height:1.5;display:flex;flex-direction:column;gap:6px;'
    const parts = markdown.split(/```[^\n]*\n([\s\S]*?)```/)
    parts.forEach((part, i) => {
        if (i % 2) {
            const pre = document.createElement('pre')
            pre.style.cssText = 'margin:0;white-space:pre-wrap;font-family:var(--font-mono, monospace);'
            pre.textContent = part.replace(/\n$/, '')
            root.append(pre)
            return
        }
        for (const para of part.split(/\n{2,}/)) {
            const text = para.trim()
            if (!text)
                continue
            const p = document.createElement('div')
            p.style.cssText = 'white-space:pre-wrap;'
            inline(p, text)
            root.append(p)
        }
    })
    return root
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': '\'', '&nbsp;': ' ' }

/** `code`, **bold**, _italic_, [text](url) as its text (the card never navigates), ![image](…) dropped, entities decoded. */
function inline(target: HTMLElement, source: string) {
    const text = source.replace(/!\[[^\]]*\]\([^)]*\)\s*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/&(?:lt|gt|amp|quot|nbsp|#39);/g, m => ENTITIES[m])
    for (const [i, seg] of text.split(/(`[^`]+`|\*\*[^*]+\*\*|\b_[^_]+_\b)/).entries()) {
        if (!seg)
            continue
        if (i % 2 === 0) {
            target.append(seg.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1'))
            continue
        }
        const el = document.createElement(seg.startsWith('`') ? 'code' : seg.startsWith('**') ? 'b' : 'i')
        if (el.tagName === 'CODE')
            el.style.cssText = 'font-family:var(--font-mono, monospace);'
        el.textContent = seg.replace(/^(`|\*\*|_)|(`|\*\*|_)$/g, '')
        target.append(el)
    }
}
