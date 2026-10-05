// Line diff model for the transcript's TUI-style diffs: parse pi's unified patch (edit tool details) or
// diff edit arguments directly, then lay rows out side by side (split) or interleaved (unified),
// with word-level ranges for paired changed lines.
import { diffWordsWithSpace, parsePatch, structuredPatch } from 'diff'

export interface DiffLine {
    kind: 'ctx' | 'add' | 'del'
    oldNo?: number
    newNo?: number
    text: string
    /** [start, end) character ranges that changed versus the paired line. */
    marks?: [number, number][]
}

export interface DiffModel {
    hunks: DiffLine[][]
    added: number
    removed: number
}

export type SplitRow = { gap: true } | { gap?: false, left?: DiffLine, right?: DiffLine }
export type UnifiedRow = { gap: true } | { gap?: false, line: DiffLine }

interface RawHunk {
    oldStart: number
    newStart: number
    lines: string[]
}

/** Pairs each run of removed lines with the following run of added lines and marks the changed words. */
function markPairs(lines: DiffLine[]) {
    for (let i = 0; i < lines.length;) {
        if (lines[i].kind !== 'del') {
            i++
            continue
        }
        const dels: DiffLine[] = []
        while (i < lines.length && lines[i].kind === 'del')
            dels.push(lines[i++])
        const adds: DiffLine[] = []
        while (i < lines.length && lines[i].kind === 'add')
            adds.push(lines[i++])
        for (let k = 0; k < Math.min(dels.length, adds.length); k++)
            markWords(dels[k], adds[k])
    }
}

const MAX_WORD_DIFF_CHARS = 2000

function markWords(del: DiffLine, add: DiffLine) {
    if (del.text.length + add.text.length > MAX_WORD_DIFF_CHARS)
        return
    const parts = diffWordsWithSpace(del.text, add.text)
    const left: [number, number][] = []
    const right: [number, number][] = []
    let a = 0
    let b = 0
    let same = 0
    for (const part of parts) {
        const n = part.value.length
        if (part.added) {
            right.push([b, b + n])
            b += n
        }
        else if (part.removed) {
            left.push([a, a + n])
            a += n
        }
        else {
            same += n
            a += n
            b += n
        }
    }
    // Mostly rewritten lines read better without confetti; the row colour already says it changed.
    if (same < Math.max(del.text.length, add.text.length) * 0.4)
        return
    if (left.length)
        del.marks = left
    if (right.length)
        add.marks = right
}

function fromHunks(raw: RawHunk[]): DiffModel {
    let added = 0
    let removed = 0
    const hunks = raw.map((h) => {
        let o = h.oldStart
        let n = h.newStart
        const lines: DiffLine[] = []
        for (const line of h.lines) {
            const sign = line[0]
            const text = line.slice(1)
            if (sign === '+') {
                lines.push({ kind: 'add', newNo: n++, text })
                added++
            }
            else if (sign === '-') {
                lines.push({ kind: 'del', oldNo: o++, text })
                removed++
            }
            else if (sign === ' ') {
                lines.push({ kind: 'ctx', oldNo: o++, newNo: n++, text })
            }
            // "\ No newline at end of file" and anything else carries no line.
        }
        markPairs(lines)
        return lines
    }).filter(lines => lines.length > 0)
    return { hunks, added, removed }
}

/** pi's edit tool returns a standard unified patch with real file line numbers in details.patch. */
export function diffFromPatch(patch: string): DiffModel | null {
    try {
        const hunks = parsePatch(patch).flatMap(file => file.hunks)
        return hunks.length ? fromHunks(hunks) : null
    }
    catch {
        return null
    }
}

/** Fallback while the edit is still running (no patch yet): diff each replacement on its own. */
export function diffFromEdits(edits: { oldText?: unknown, newText?: unknown }[]): DiffModel {
    const hunks = edits.flatMap(e => structuredPatch('a', 'b', String(e.oldText ?? ''), String(e.newText ?? ''), '', '', { context: 3 }).hunks)
    return fromHunks(hunks)
}

/** A write shows the whole file as added lines. */
export function diffFromContent(content: string): DiffModel {
    const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
    return {
        hunks: content ? [lines.map((text, i) => ({ kind: 'add' as const, newNo: i + 1, text }))] : [],
        added: content ? lines.length : 0,
        removed: 0,
    }
}

export function splitRows(model: DiffModel): SplitRow[] {
    const rows: SplitRow[] = []
    model.hunks.forEach((lines, h) => {
        if (h > 0)
            rows.push({ gap: true })
        for (let i = 0; i < lines.length;) {
            const line = lines[i]
            if (line.kind === 'ctx') {
                rows.push({ left: line, right: line })
                i++
                continue
            }
            const dels: DiffLine[] = []
            while (i < lines.length && lines[i].kind === 'del')
                dels.push(lines[i++])
            const adds: DiffLine[] = []
            while (i < lines.length && lines[i].kind === 'add')
                adds.push(lines[i++])
            for (let k = 0; k < Math.max(dels.length, adds.length); k++)
                rows.push({ left: dels[k], right: adds[k] })
        }
    })
    return rows
}

export function unifiedRows(model: DiffModel): UnifiedRow[] {
    const rows: UnifiedRow[] = []
    model.hunks.forEach((lines, h) => {
        if (h > 0)
            rows.push({ gap: true })
        for (const line of lines)
            rows.push({ line })
    })
    return rows
}
