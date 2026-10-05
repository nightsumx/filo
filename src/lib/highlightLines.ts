// Syntax highlighting for diff rows: highlight a whole side at once (so multi-line strings and
// comments keep their context), then cut highlight.js's HTML back into per-line token lists.
import hljs from 'highlight.js/lib/common'

export interface Token {
    text: string
    cls: string
}

const MAX_CHARS = 120_000

export function highlightLines(lines: string[], language: string): Token[][] | null {
    const source = lines.join('\n')
    if (!source || source.length > MAX_CHARS || !hljs.getLanguage(language))
        return null
    let html: string
    try {
        html = hljs.highlight(source, { language, ignoreIllegals: true }).value
    }
    catch {
        return null
    }
    // hljs escapes its input, so this markup only ever contains its own <span class> elements.
    const root = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstChild
    const out: Token[][] = [[]]
    const walk = (node: Node, cls: string) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const parts = (node.textContent ?? '').split('\n')
            parts.forEach((text, i) => {
                if (i > 0)
                    out.push([])
                if (text)
                    out[out.length - 1].push({ text, cls })
            })
            return
        }
        const own = node instanceof Element ? node.getAttribute('class') ?? '' : ''
        const next = own ? (cls ? `${cls} ${own}` : own) : cls
        node.childNodes.forEach(child => walk(child, next))
    }
    if (root)
        root.childNodes.forEach(child => walk(child, ''))
    return out.length === lines.length ? out : null
}
