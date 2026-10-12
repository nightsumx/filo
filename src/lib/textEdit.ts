// Pure text helpers for the editor tabs: line endings, indentation, and the smallest change that
// turns the editor's text into what an agent (or anything else) wrote to disk.

/** The line break a file uses: CRLF when it has any, else LF. */
export function detectEol(text: string): '\n' | '\r\n' {
    return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Every line break as LF, the form the editor's document compares in. */
export function toLf(text: string): string {
    return text.includes('\r') ? text.split('\r\n').join('\n').split('\r').join('\n') : text
}

/**
 * The one replacement of `before` that yields `after`: everything between their common prefix and
 * common suffix. Applied to the editor, text outside it keeps its place, so the cursor, selection
 * and scroll position stay where they were. Never cuts a surrogate pair in two.
 */
export function minimalChange(before: string, after: string): { from: number, to: number, insert: string } | null {
    if (before === after)
        return null
    const max = Math.min(before.length, after.length)
    let start = 0
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start))
        start++
    if (start > 0 && isHigh(before.charCodeAt(start - 1)))
        start--
    let end = 0
    while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end))
        end++
    if (end > 0 && isLow(before.charCodeAt(before.length - end)))
        end--
    return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) }
}

const isHigh = (code: number) => code >= 0xD800 && code <= 0xDBFF
const isLow = (code: number) => code >= 0xDC00 && code <= 0xDFFF

/**
 * How the file indents: a tab, or the smallest step its space-indented lines go up by (2, 4...).
 * Looks at the first lines only; files with no indented lines get `fallback`.
 */
export function detectIndent(text: string, fallback = '    '): string {
    let tabs = 0
    let spaces = 0
    const steps = new Map<number, number>()
    let previous = 0
    let seen = 0
    for (const line of text.split('\n', 2000)) {
        if (!line.trim())
            continue
        let width = 0
        while (line[width] === ' ')
            width++
        if (line[0] === '\t') {
            tabs++
        }
        else if (width > 0) {
            spaces++
            // A line deeper than the one before shows the step; JSDoc's " * " continuation (one
            // space) does not count.
            const step = width - previous
            if (step > 1)
                steps.set(step, (steps.get(step) ?? 0) + 1)
        }
        previous = line[0] === '\t' ? previous : width
        if (++seen >= 1000)
            break
    }
    if (tabs > spaces)
        return '\t'
    if (!spaces || !steps.size)
        return fallback
    const [step] = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
    return ' '.repeat(Math.min(step, 8))
}
