// Terminal prompts for the capabilities, in Claude Code's style: a rounded box, numbered choices with
// ❯ on the selected one, digits pick directly, enter confirms, esc dismisses. The desktop app never
// reaches these; capabilities call them only when ctx.mode === 'tui'. A `signal` closes the dialog
// as dismissed: the desktop app answered it first, over pi-cc-tui's bridge.
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import type { AskAnswer, AskQuestion } from '../protocol'
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

const STYLE_KEY = Symbol.for('pi-kit.tui-style')

/** Hosts such as pi-cc-tui can set the accent colour of the boxes; the theme's accent otherwise. */
export function setTuiStyle(style: { accent?: (text: string) => string }) {
    (globalThis as any)[STYLE_KEY] = style
}

export const accent = (theme: Theme, text: string): string => (globalThis as any)[STYLE_KEY]?.accent?.(text) ?? theme.fg('accent', text)

/** A row is wrapped to the box width; an array of lines is used as is (already fitted, e.g. an Input). */
type Row = string | string[]

/** Rounded box around rows, padded to the full width. */
export function frame(theme: Theme, width: number, rows: Row[]): string[] {
    const inner = Math.max(1, width - 4)
    const side = accent(theme, '│')
    const lines = rows.flatMap(row => Array.isArray(row) ? row : row ? wrapTextWithAnsi(row, inner).map(l => truncateToWidth(l, inner, '')) : [''])
    const rule = '─'.repeat(Math.max(0, width - 2))
    return [
        accent(theme, `╭${rule}╮`),
        ...lines.map(line => `${side} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${side}`),
        accent(theme, `╰${rule}╯`),
    ]
}

// One prompt at a time: tool calls in a parallel batch wait for the one before.
let queue: Promise<unknown> = Promise.resolve()
export function serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
}

export interface Choice {
    title: string
    body?: string[]
    /** Markdown shown under the body, e.g. the plan being approved. */
    markdown?: string
    question: string
    options: string[]
}

/** ctx.ui.custom, closed with `dismissed` when `signal` aborts. */
function closable<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, dismissed: T, factory: Parameters<ExtensionContext['ui']['custom']>[0]): Promise<T> {
    if (signal?.aborted)
        return Promise.resolve(dismissed)
    return ctx.ui.custom<T>((tui, theme, kb, done) => {
        let finished = false
        const finish = (result: T) => {
            if (finished)
                return
            finished = true
            signal?.removeEventListener('abort', onAbort)
            done(result)
        }
        const onAbort = () => finish(dismissed)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted)
            queueMicrotask(onAbort)
        return factory(tui, theme, kb, finish as (result: unknown) => void)
    })
}

/** Index of the chosen option, or undefined when dismissed with esc / ctrl+c. */
export function choose(ctx: ExtensionContext, choice: Choice, signal?: AbortSignal): Promise<number | undefined> {
    const { title, body = [], question, options } = choice
    return closable<number | undefined>(ctx, signal, undefined, (tui, theme, _kb, done) => {
        let selected = 0
        const markdown = choice.markdown?.trim() ? new Markdown(choice.markdown.trim(), 0, 0, getMarkdownTheme()) : undefined
        return {
            invalidate() {},
            handleInput(data: string) {
                const digit = Number(data)
                if (Number.isInteger(digit) && digit >= 1 && digit <= options.length)
                    return done(digit - 1)
                if (matchesKey(data, 'up'))
                    selected = (selected + options.length - 1) % options.length
                else if (matchesKey(data, 'down') || matchesKey(data, 'tab'))
                    selected = (selected + 1) % options.length
                else if (matchesKey(data, 'enter'))
                    return done(selected)
                else if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c'))
                    return done(undefined)
                else
                    return
                tui.requestRender()
            },
            render(width: number) {
                return frame(theme, width, [
                    theme.bold(accent(theme, title)),
                    ...(body.length ? ['', ...body] : []),
                    ...(markdown ? ['', markdown.render(Math.max(1, width - 4))] : []),
                    '',
                    question,
                    ...options.map((o, i) => i === selected ? accent(theme, `❯ ${i + 1}. ${o}`) : `  ${i + 1}. ${o}`),
                ])
            },
        }
    })
}

/**
 * The ask form: one question at a time, its choices plus "Type something" for a free answer.
 * Multiple-choice questions toggle with space or enter and move on from "Submit". Undefined when
 * dismissed.
 */
export function askQuestions(ctx: ExtensionContext, questions: AskQuestion[], signal?: AbortSignal): Promise<Record<string, AskAnswer> | undefined> {
    return closable<Record<string, AskAnswer> | undefined>(ctx, signal, undefined, (tui, theme, _kb, done) => {
        const answers: Record<string, AskAnswer> = {}
        let index = 0
        let selected = 0
        let checked = new Set<number>()
        const newInput = () => new Input({ prompt: '' })
        let input = newInput()
        let isFocused = false

        const question = () => questions[index]
        // Rows: the options, "Type something", and for multiple choice "Submit".
        const otherRow = () => question().options.length
        const submitRow = () => question().multiple ? otherRow() + 1 : -1
        const rowCount = () => otherRow() + (question().multiple ? 2 : 1)
        const syncFocus = () => {
            input.focused = isFocused && selected === otherRow()
        }

        const next = () => {
            const q = question()
            const text = input.getValue().trim()
            answers[q.id] = { selected: q.options.filter((_, i) => checked.has(i)), ...(text ? { text } : {}) }
            if (index === questions.length - 1)
                return done(answers)
            index++
            selected = 0
            checked = new Set()
            input = newInput()
            syncFocus()
            tui.requestRender()
        }

        const component = {
            get focused() {
                return isFocused
            },
            set focused(value: boolean) {
                isFocused = value
                syncFocus()
            },
            invalidate() {},
            handleInput(data: string) {
                const q = question()
                if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c'))
                    return done(undefined)
                if (matchesKey(data, 'up'))
                    selected = (selected + rowCount() - 1) % rowCount()
                else if (matchesKey(data, 'down') || matchesKey(data, 'tab'))
                    selected = (selected + 1) % rowCount()
                else if (selected === otherRow()) {
                    // Typing goes to the free answer; enter submits it.
                    if (matchesKey(data, 'enter')) {
                        if (!input.getValue().trim())
                            return
                        if (!q.multiple)
                            checked.clear()
                        return next()
                    }
                    input.handleInput(data)
                }
                else if (matchesKey(data, 'enter') || (q.multiple && data === ' ')) {
                    if (selected === submitRow())
                        return next()
                    if (!q.multiple) {
                        checked = new Set([selected])
                        return next()
                    }
                    if (checked.has(selected))
                        checked.delete(selected)
                    else
                        checked.add(selected)
                }
                else {
                    const digit = Number(data)
                    if (!Number.isInteger(digit) || digit < 1 || digit > q.options.length)
                        return
                    selected = digit - 1
                    if (!q.multiple) {
                        checked = new Set([selected])
                        return next()
                    }
                    if (checked.has(selected))
                        checked.delete(selected)
                    else
                        checked.add(selected)
                }
                syncFocus()
                tui.requestRender()
            },
            render(width: number) {
                const q = question()
                const inner = Math.max(1, width - 4)
                const pointer = (i: number) => i === selected ? accent(theme, '❯ ') : '  '
                const box = (i: number) => q.multiple ? (checked.has(i) ? '[✔] ' : '[ ] ') : ''
                const rows: Row[] = [
                    theme.bold(accent(theme, questions.length > 1 ? `Question ${index + 1} of ${questions.length}` : 'Question')),
                    '',
                    theme.bold(q.question),
                    '',
                    ...q.options.map((o, i) => {
                        const line = `${box(i)}${i + 1}. ${o}`
                        return pointer(i) + (i === selected ? accent(theme, line) : line)
                    }),
                ]
                const label = `${box(-1).replace('✔', ' ')}${q.options.length + 1}. `
                if (selected === otherRow() || input.getValue())
                    rows.push(input.render(Math.max(1, inner - 2 - visibleWidth(label))).map((line, i) => i ? `  ${' '.repeat(visibleWidth(label))}${line}` : `${pointer(otherRow())}${label}${line}`))
                else
                    rows.push(`${pointer(otherRow())}${theme.fg('muted', `${label}Type something`)}`)
                if (q.multiple)
                    rows.push(`${pointer(submitRow())}${selected === submitRow() ? accent(theme, 'Submit') : 'Submit'}`)
                const keys = q.multiple ? 'Space to toggle · Enter on Submit to continue' : 'Enter to select'
                rows.push('', theme.fg('muted', `${keys} · ↑/↓ to navigate · Esc to cancel`))
                return frame(theme, width, rows)
            },
        }
        return component
    })
}
