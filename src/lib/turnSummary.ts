// Codex-style folding of a finished turn: everything up to the last tool call / thinking block is
// "process" and folds into one summary line ("Ran 3 commands, edited 2 files +12 -3"); the answer
// after it stays visible.
import type { Step } from './timeline'
import { diffFromContent, diffFromEdits } from './diffModel'

export interface TurnSplit {
    process: Step[]
    tail: Step[]
}

/** Splits after the last tool / thinking step. Text, errors and notes after it are the answer. */
export function splitTurn(steps: Step[]): TurnSplit {
    let cut = 0
    steps.forEach((step, i) => {
        if (step.kind === 'tool' || step.kind === 'thinking')
            cut = i + 1
    })
    return { process: steps.slice(0, cut), tail: steps.slice(cut) }
}

export interface TurnStats {
    commands: number
    /** Distinct files read. */
    reads: number
    /** grep / find / ls calls. */
    searches: number
    /** Distinct files edited or written (apply_patch counts once per call). */
    edited: number
    added: number
    removed: number
    /** Any other tool: capability tools, MCP, custom extension tools. */
    other: number
    failed: number
    thinking: boolean
    /** Time spent generating thinking blocks, when known. */
    thinkingMs?: number
    /** When the last of these steps finished, when known. */
    endedAt?: number
}

const SEARCH_TOOLS = new Set(['grep', 'find', 'ls', 'glob'])
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch'])

/** Lines added / removed in a unified patch, without the cost of a full diff model. */
function countPatch(patch: string): { added: number, removed: number } {
    let added = 0
    let removed = 0
    for (const line of patch.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---'))
            continue
        if (line.startsWith('+'))
            added++
        else if (line.startsWith('-'))
            removed++
    }
    return { added, removed }
}

function editDelta(step: Extract<Step, { kind: 'tool' }>): { added: number, removed: number } {
    const args = step.call.arguments ?? {}
    const patch = step.result?.details?.patch
    if (typeof patch === 'string' && patch)
        return countPatch(patch)
    if (step.call.name === 'write')
        return typeof args.content === 'string' ? diffFromContent(args.content) : { added: 0, removed: 0 }
    if (step.call.name === 'edit') {
        const edits = Array.isArray(args.edits)
            ? args.edits
            : args.oldText != null || args.newText != null ? [{ oldText: args.oldText, newText: args.newText }] : []
        return edits.length ? diffFromEdits(edits) : { added: 0, removed: 0 }
    }
    return { added: 0, removed: 0 }
}

export function turnStats(steps: Step[]): TurnStats {
    const stats: TurnStats = { commands: 0, reads: 0, searches: 0, edited: 0, added: 0, removed: 0, other: 0, failed: 0, thinking: false }
    const read = new Set<string>()
    const edited = new Set<string>()
    for (const step of steps) {
        const end = 'endedAt' in step ? step.endedAt : undefined
        if (end !== undefined)
            stats.endedAt = Math.max(stats.endedAt ?? 0, end)
        if (step.kind === 'thinking') {
            stats.thinking = true
            if (step.ms !== undefined)
                stats.thinkingMs = (stats.thinkingMs ?? 0) + step.ms
            continue
        }
        if (step.kind !== 'tool')
            continue
        const { name, arguments: args = {} } = step.call
        const path = String(args.path ?? args.file_path ?? '')
        if (step.result?.isError)
            stats.failed++
        if (name === 'bash')
            stats.commands++
        else if (name === 'read')
            read.add(path || step.key)
        else if (SEARCH_TOOLS.has(name))
            stats.searches++
        else if (EDIT_TOOLS.has(name)) {
            edited.add(name === 'apply_patch' || !path ? step.key : path)
            if (!step.result?.isError) {
                const d = editDelta(step)
                stats.added += d.added
                stats.removed += d.removed
            }
        }
        else
            stats.other++
    }
    stats.reads = read.size
    stats.edited = edited.size
    return stats
}
