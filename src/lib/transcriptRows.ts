import type { StepItem, Turn, UserPrompt } from './timeline'
import { groupSteps } from './timeline'

/**
 * The transcript flattened into rows for the virtualizer. One agent turn can hold hundreds of
 * tool calls, so a turn is too coarse a unit: every step (or tool group) is its own row.
 */
export type TranscriptRow =
    | { kind: 'user', key: string, turn: Turn, user: UserPrompt, first: boolean }
    | { kind: 'item', key: string, turn: Turn, item: StepItem, first: boolean }
    /** Streaming steps + the "✶ Churning…" line under the last running turn. */
    | { kind: 'live', key: string, turn: Turn, first: boolean }
    /** "✻ Worked for 3m 12s · done 4:12 PM" closing a finished turn. */
    | { kind: 'footer', key: string, turn: Turn, first: boolean, finalText: string }

export function transcriptRows(turns: Turn[]): TranscriptRow[] {
    const rows: TranscriptRow[] = []
    turns.forEach((turn, i) => {
        const start = rows.length
        const first = () => rows.length === start
        if (turn.user)
            rows.push({ kind: 'user', key: `${turn.key}:user`, turn, user: turn.user, first: true })
        for (const item of groupSteps(turn.steps))
            rows.push({ kind: 'item', key: item.kind === 'group' ? item.key : item.step.key, turn, item, first: first() })
        const isLast = i === turns.length - 1
        if (isLast && turn.running)
            rows.push({ kind: 'live', key: `${turn.key}:live`, turn, first: first() })
        const hasWork = turn.steps.some(s => s.kind === 'tool' || s.kind === 'text' || s.kind === 'thinking')
        if (!turn.running && turn.user && hasWork) {
            const texts = turn.steps.filter(s => s.kind === 'text')
            const finalText = texts.length ? (texts[texts.length - 1] as { text: string }).text : ''
            rows.push({ kind: 'footer', key: `${turn.key}:footer`, turn, first: first(), finalText })
        }
    })
    return rows
}
