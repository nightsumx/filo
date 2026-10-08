// First-paint height guess for a transcript row, before the virtualizer has measured it. Close
// guesses keep the scrollbar steady and make the scroll corrections on first measure small.
// Constants are the rendered sizes at the 13.5px transcript font (line-height 1.65), fitted against
// real sessions; text is wrapped by an approximate glyph width.
import type { Step } from './timeline'
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
/** User bubbles taller than this scroll inside (TurnView), so a pasted log doesn't fill the transcript. */
export const USER_BUBBLE_MAX_HEIGHT = 320
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

type ToolStep = Extract<Step, { kind: 'tool' }>

/** Child transcript cap (SubagentStep's max-h-[420px]) and the steer field under it. */
const SUBAGENT_TRANSCRIPT = 420
const SUBAGENT_CONTROLS = 38

/**
 * Finished subagents fold to their row. A running one is open: task line, the child's transcript
 * (capped, it scrolls) and the steer field.
 */
function subagentHeight(step: ToolStep, width: number): number {
    if (!step.running)
        return ROW_LINE
    const details = step.result?.details
    const inner = width - 14
    let transcript = 0
    const messages = [...(details?.messages ?? []), ...(details?.streaming ? [details.streaming] : [])]
    for (const message of messages) {
        if (message?.role !== 'assistant')
            continue
        for (const block of message.content ?? []) {
            if (block.type === 'text' && block.text)
                transcript += 2 + markdownHeight(block.text, inner).height
            else if (block.type === 'thinking' && block.thinking)
                transcript += 2 + ROW_LINE + Math.min(THINKING_LINES, markdownHeight(block.thinking, inner).lines) * LINE
            else if (block.type === 'toolCall')
                transcript += 2 + ROW_LINE + RESULT_LINE
        }
    }
    const steering = (details?.steering?.length ?? 0) * 20
    return ROW_LINE + 6 + ROW_LINE + Math.min(SUBAGENT_TRANSCRIPT, transcript) + (details ? SUBAGENT_CONTROLS + steering : 0)
}

/** Header, summary, scope line, one row per recheck and item, the send form and the process toggle. Items start closed. */
function reviewHeight(step: Extract<Step, { kind: 'review' }>, width: number): number {
    const r = step.report
    if (r.status !== 'done')
        return ROW_LINE + (r.error ? LINE : 0) + ROW_LINE
    const items = r.issues.length + r.suggestions.length
    return ROW_LINE + 2 + markdownHeight(r.summary, width - 22).height + 18 + 6 + (r.rechecks.length + items) * ROW_LINE + (items ? 6 + 28 : 0) + 2 + ROW_LINE
}

/** Lines of 12.5px text (leading-5) at the given width; textWidth is measured at the 13.5px body size. */
function smallLines(text: string | undefined, width: number): number {
    if (!text)
        return 0
    return text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l) * (12.5 / 13.5) / Math.max(120, width))), 0)
}

const SMALL_LINE = 20

/** Autopilot decision: its line, then the reason and the valve or error under it; the commands open on click. */
function autopilotHeight(step: Extract<Step, { kind: 'autopilot' }>, width: number): number {
    const d = step.decision
    return ROW_LINE + (smallLines(d.reason, width) + smallLines(d.valve, width - 18) + smallLines(d.error, width)) * SMALL_LINE
}

/** An answered card is one line; a pending one is the whole form (see AutopilotCardStep). */
function cardHeight(step: Extract<Step, { kind: 'autopilot-card' }>, width: number): number {
    if (step.answer)
        return ROW_LINE
    const c = step.card
    const optionWidth = width - 16 - 24
    let h = ROW_LINE + smallLines(c.question, width) * SMALL_LINE
    if (c.gate)
        h += 4 + 12 + smallLines(c.gate.summary, width - 24) * SMALL_LINE
    if (c.rules)
        h += (c.rules.summary ? 4 + smallLines(c.rules.summary, width) * SMALL_LINE : 0) + ROW_LINE
    if (c.held)
        h += smallLines(c.held, width) * SMALL_LINE
    if (c.evidence?.length)
        h += 4 + c.evidence.length * SMALL_LINE
    for (const o of c.options)
        h += 8 + smallLines(`${o.label}${o.id === c.recommended ? ' recommended' : ''}${o.detail ? ` — ${o.detail}` : ''}`, optionWidth) * SMALL_LINE
    // Margins, the own-words field and the fallback line.
    h += 4 + 4 + 28 + 4
    if (c.fallback)
        h += smallLines(c.fallback, width - 8) * SMALL_LINE
    return h
}

/** A pending ask is a form (question, choices, buttons); an answered one lists question → answer. */
function askHeight(step: ToolStep): number {
    const details = step.result?.details
    const questions: unknown[] = details?.questions ?? (Array.isArray(step.call.arguments?.questions) ? step.call.arguments.questions : [])
    if (step.running && details?.status === 'pending')
        return ROW_LINE + 6 + questions.length * 56 + questions.length * 20 + 28 + 8
    return ROW_LINE + (questions.length ? questions.length * 20 + 4 : 0)
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
            // Review feedback: a heading, one line per item, then the note.
            if (row.user.review) {
                const note = row.user.text ? row.user.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l) / bubble)), 0) : 0
                return (row.first ? 24 : 12) + 12 + (1 + row.user.review.items.length + note) * 20
            }
            // Autopilot's prompt: a source line over the text.
            if (row.user.autopilot) {
                const lines = row.user.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l) / bubble)), 0)
                return (row.first ? 24 : 12) + Math.min(USER_BUBBLE_MAX_HEIGHT, 12 + 20 + lines * 22)
            }
            const lines = row.user.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l) / bubble)), 0)
            return (row.first ? 24 : 12) + Math.min(USER_BUBBLE_MAX_HEIGHT, 12 + lines * 22) + (row.user.images.length ? 86 : 0)
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
                    if (step.call.name === 'subagent')
                        return pad + subagentHeight(step, width)
                    if (step.call.name === 'ask')
                        return pad + askHeight(step)
                    // One summary row; the list opens on click.
                    if (step.call.name === 'todo')
                        return pad + ROW_LINE
                    if (step.call.name === 'propose_plan') {
                        const details = step.result?.details
                        const plan = String(details?.plan ?? step.call.arguments?.plan ?? '')
                        if (details?.status === 'revised')
                            return pad + ROW_LINE + RESULT_LINE
                        if (details?.status === 'cancelled')
                            return pad + ROW_LINE
                        return pad + ROW_LINE + 20 + markdownHeight(plan, width - 24).height + (step.running ? 44 : 0)
                    }
                    if (step.call.name === 'edit' && !step.result?.isError)
                        return pad + ROW_LINE + RESULT_LINE + 16 + Math.min(DIFF_ROWS, editLines(step.call.arguments) + 6) * DIFF_ROW
                    return pad + ROW_LINE + RESULT_LINE
                case 'review':
                    return pad + reviewHeight(step, width)
                case 'autopilot':
                    return pad + autopilotHeight(step, width)
                case 'autopilot-card':
                    return pad + cardHeight(step, width)
                case 'bash':
                    return pad + ROW_LINE + (step.message.output ? 16 + Math.min(10, step.message.output.split('\n').length) * 18 : 0)
                default:
                    return pad + ROW_LINE
            }
        }
    }
}
