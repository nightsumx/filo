// First-paint height guess for a transcript row, before the virtualizer has measured it. Close
// guesses keep the scrollbar steady and make the scroll corrections on first measure small.
// Constants are the rendered sizes at the 13.5px transcript font (line-height 1.65), fitted against
// real sessions; text is wrapped by an approximate glyph width.
import type { TranscriptRow } from './transcriptRows'

const LINE = 22.3
/** Gap between markdown blocks (paragraph / list margins). */
const BLOCK_GAP = 13.5
const TABLE_ROW = 26
const CODE_LINE = 20
/** Extra height of a heading line over a body line. */
const HEADING = 24
/** Gutter mark + gap in front of every step, and the list's side padding. */
const GUTTER = 22
const SIDE_PADDING = 40
const MAX_WIDTH = 1024
/** One-line row: a tool title, a fold line, a footer. */
const ROW_LINE = 24
const RESULT_LINE = 22
const THINKING_LINES = 5
const SHOW_MORE = 27
const DIFF_ROW = 21
const DIFF_ROWS = 24

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

/** Approximate rendered width of a line of transcript text, px. */
function textWidth(line: string): number {
    let w = 0
    for (const c of line)
        w += WIDE.test(c) ? 13.5 : 7
    return w
}

/** Height of rendered markdown at the given content width, px. */
export function markdownHeight(text: string, width: number): { height: number, lines: number } {
    let lines = 0
    let height = 0
    let blocks = 0
    let inCode = false
    let blank = true
    for (const raw of text.replace(/\n+$/, '').split('\n')) {
        if (/^\s*```/.test(raw)) {
            inCode = !inCode
            if (inCode)
                blocks++
            blank = false
            continue
        }
        if (inCode) {
            height += CODE_LINE
            continue
        }
        const line = raw.trim()
        if (!line) {
            blank = true
            continue
        }
        if (blank)
            blocks++
        blank = false
        if (line.startsWith('|')) {
            // The |---| separator row draws nothing.
            if (!/^\|[\s:|-]+\|?$/.test(line))
                height += TABLE_ROW
            continue
        }
        const item = /^(?:[-*+]|\d+[.)])\s/.test(line)
        if (/^#+\s/.test(line))
            height += HEADING
        const wrapped = Math.max(1, Math.ceil(textWidth(line.replace(/[*`_]/g, '')) / Math.max(200, width - (item ? 24 : 0))))
        lines += wrapped
        height += wrapped * LINE
    }
    return { height: height + Math.max(0, blocks - 1) * BLOCK_GAP, lines }
}

/** Lines an edit call changes, roughly the rows of its diff. */
function editLines(args: Record<string, any> | undefined): number {
    const edits = Array.isArray(args?.edits) ? args.edits : [{ oldText: args?.oldText, newText: args?.newText }]
    let n = 0
    for (const e of edits) {
        for (const t of [e?.oldText, e?.newText]) {
            if (typeof t === 'string')
                n += t.split('\n').length
        }
    }
    return n
}

/** `listWidth` is the scroll container's client width. Whole pixels, like measured sizes. */
export function estimateRow(row: TranscriptRow, listWidth: number): number {
    return Math.round(estimate(row, listWidth))
}

function estimate(row: TranscriptRow, listWidth: number): number {
    const pad = row.first && row.kind !== 'user' ? 24 : 12
    const width = Math.min(listWidth || 900, MAX_WIDTH) - SIDE_PADDING - GUTTER
    switch (row.kind) {
        case 'user': {
            // Bubble: 15% left inset, px-3 padding, leading-relaxed lines.
            const bubble = Math.min(listWidth || 900, MAX_WIDTH) * 0.85 - SIDE_PADDING - 24
            const lines = row.user.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l) / bubble)), 0)
            return (row.first ? 24 : 12) + 12 + lines * 22 + (row.user.images.length ? 86 : 0)
        }
        case 'live':
        case 'fold':
        case 'footer':
            return pad + ROW_LINE
        case 'item': {
            if (row.item.kind === 'group')
                return pad + ROW_LINE + row.item.steps.length * RESULT_LINE
            const step = row.item.step
            switch (step.kind) {
                case 'text':
                    return pad + Math.max(LINE, markdownHeight(step.text, width).height)
                case 'thinking': {
                    if (step.redacted || !step.text)
                        return pad + ROW_LINE
                    const { height, lines } = markdownHeight(step.text, width)
                    // Clipped to five lines with a "… N more lines" toggle under it.
                    return pad + ROW_LINE + (lines > THINKING_LINES ? Math.ceil(THINKING_LINES * LINE) + 2 + SHOW_MORE : height)
                }
                case 'tool':
                    if (step.call.name === 'edit' && !step.result?.isError)
                        return pad + ROW_LINE + RESULT_LINE + 16 + Math.min(DIFF_ROWS, editLines(step.call.arguments) + 6) * DIFF_ROW
                    return pad + ROW_LINE + RESULT_LINE
                case 'bash':
                    return pad + ROW_LINE + (step.message.output ? 16 + Math.min(10, step.message.output.split('\n').length) * 18 : 0)
                default:
                    return pad + ROW_LINE
            }
        }
    }
}
