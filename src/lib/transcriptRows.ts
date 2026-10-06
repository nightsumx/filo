import type { Step, StepItem, Turn, UserPrompt } from './timeline'
import { groupSteps } from './timeline'
import { splitTurn } from './turnSummary'

/**
 * The transcript flattened into rows for the virtualizer. One agent turn can hold hundreds of
 * tool calls, so a turn is too coarse a unit: every step (or tool group) is its own row.
 */
export type TranscriptRow =
    | { kind: 'user', key: string, turn: Turn, user: UserPrompt, first: boolean }
    /** `inFold`: part of an unfolded process, under its fold row (MessageList pins that row on top). */
    | { kind: 'item', key: string, turn: Turn, item: StepItem, first: boolean, inFold?: boolean }
    /** "› Ran 3 commands, edited 2 files +12 -3": a finished turn's process, folded unless open. */
    | { kind: 'fold', key: string, turn: Turn, steps: Step[], open: boolean, first: boolean }
    /** Streaming steps + the "✶ Churning…" line under the last running turn. */
    | { kind: 'live', key: string, turn: Turn, first: boolean }
    /** "✻ Worked for 3m 12s · done 4:12 PM" closing a finished turn. */
    | { kind: 'footer', key: string, turn: Turn, first: boolean, finalText: string }

function isPinned(step: Step): boolean {
    return step.kind === 'tool' && step.call.name === 'propose_plan' && step.result?.details?.status === 'approved'
}

/** `open` holds the keys of finished turns the user unfolded. */
export function transcriptRows(turns: Turn[], open: ReadonlySet<string> = new Set()): TranscriptRow[] {
    const rows: TranscriptRow[] = []
    turns.forEach((turn, i) => {
        const start = rows.length
        const first = () => rows.length === start
        const pushItems = (steps: Step[], inFold?: boolean) => {
            for (const item of groupSteps(steps))
                rows.push({ kind: 'item', key: item.kind === 'group' ? item.key : item.step.key, turn, item, first: first(), ...(inFold && { inFold }) })
        }
        if (turn.user)
            rows.push({ kind: 'user', key: `${turn.key}:user`, turn, user: turn.user, first: true })
        // A turn without a prompt can still be agent work: the rest of a run that pi compacted
        // midway continues after the summary. It folds and gets a footer like the prompt's turn.
        const hasWork = turn.steps.some(s => s.kind === 'tool' || s.kind === 'text' || s.kind === 'thinking')
        const agentTurn = !!turn.user || hasWork
        // Only finished turns fold; a running turn shows its work as it happens.
        const { process, tail } = splitTurn(turn.steps)
        // An approved plan is what the work was agreed on: it stays above the fold.
        const pinned = process.filter(isPinned)
        if (!turn.running && agentTurn && process.length > pinned.length) {
            const isOpen = open.has(turn.key)
            if (!isOpen)
                pushItems(pinned)
            rows.push({ kind: 'fold', key: `${turn.key}:fold`, turn, steps: process, open: isOpen, first: first() })
            if (isOpen)
                pushItems(process, true)
            pushItems(tail)
        }
        else {
            pushItems(turn.steps)
        }
        const isLast = i === turns.length - 1
        if (isLast && turn.running)
            rows.push({ kind: 'live', key: `${turn.key}:live`, turn, first: first() })
        if (!turn.running && hasWork) {
            const texts = turn.steps.filter(s => s.kind === 'text')
            const finalText = texts.length ? (texts[texts.length - 1] as { text: string }).text : ''
            rows.push({ kind: 'footer', key: `${turn.key}:footer`, turn, first: first(), finalText })
        }
    })
    return rows
}
