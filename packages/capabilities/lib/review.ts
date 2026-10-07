// The parts of review that need no process: what the reviewer is told (facts from the session
// branch and the diff, never the agent's reasoning), how its submission becomes a report (runtime
// evidence decides confirmed vs suspected), and how picked items go back to the agent.
import type { ReviewApply, ReviewDetails, ReviewEvidence, ReviewFeedbackDetails, ReviewIssue, ReviewRecheck, ReviewSeverity, ReviewSuggestion, SubagentDetails } from '../protocol'
import path from 'node:path'
import { clip } from './child'

export const REVIEW_TYPES = { report: 'pi-kit-review', feedback: 'pi-kit-review-feedback' } as const

/** Per-message and total sizes of what the reviewer is told; the diff has its own budget. */
const MESSAGE_CLIP = 3000
const MESSAGES_BUDGET = 16_000
const CLAIMS_BUDGET = 8000
export const DIFF_BUDGET = 60_000
/** Tail of a command's output kept as evidence. */
const EVIDENCE_TAIL = 1500

// ---------------------------------------------------------------- the session branch

const textOf = (content: unknown): string => typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('\n') : ''

/** A branch entry as a message, for `message` and `custom_message` entries. */
function messageOf(entry: any): any {
    if (entry?.type === 'message')
        return entry.message
    if (entry?.type === 'custom_message')
        return { role: 'custom', customType: entry.customType, content: entry.content, details: entry.details }
    return undefined
}

export interface PreviousReview {
    report: ReviewDetails
    /** Items the user sent back, with their titles. */
    sent: { id: string, title: string }[]
    note?: string
    /** The agent's replies after the feedback. */
    replies: string[]
}

export interface BranchFacts {
    /** The user's messages, oldest first. */
    requests: string[]
    /** The agent's final reply of each turn, oldest first. */
    claims: string[]
    /** Absolute paths of files the agent's edit/write calls touched. */
    files: string[]
    round: number
    previous?: PreviousReview
}

/** Keeps the first item and as many of the latest as fit `budget`, each clipped to `each`. */
function fit(items: string[], each: number, budget: number): string[] {
    const clipped = items.map(t => clip(t.trim(), each)).filter(Boolean)
    if (clipped.join('').length <= budget)
        return clipped
    const [first, ...rest] = clipped
    const kept: string[] = []
    let used = first.length
    for (let i = rest.length - 1; i >= 0 && used + rest[i].length <= budget; i--) {
        kept.unshift(rest[i])
        used += rest[i].length
    }
    const dropped = rest.length - kept.length
    return [first, ...(dropped ? [`(${dropped} earlier message${dropped === 1 ? '' : 's'} omitted)`] : []), ...kept]
}

const itemTitle = (report: ReviewDetails, id: string) =>
    report.issues.find(i => i.id === id)?.title ?? report.suggestions.find(s => s.id === id)?.title ?? id

/** What the reviewer gets from the branch (session entries root to leaf). */
export function branchFacts(entries: readonly any[], cwd: string): BranchFacts {
    const requests: string[] = []
    const claims: string[] = []
    const files = new Set<string>()
    let round = 1
    let previous: PreviousReview | undefined
    let turnReply = ''
    const endTurn = () => {
        if (turnReply)
            claims.push(turnReply)
        turnReply = ''
    }
    for (const entry of entries) {
        if (entry?.type === 'custom' && entry.customType === REVIEW_TYPES.report && entry.data?.kind === 'review') {
            if (entry.data.status === 'done') {
                round++
                previous = { report: entry.data, sent: [], replies: [] }
            }
            continue
        }
        const message = messageOf(entry)
        if (!message)
            continue
        if (message.role === 'user') {
            endTurn()
            requests.push(textOf(message.content))
        }
        else if (message.role === 'custom' && message.customType === REVIEW_TYPES.feedback) {
            endTurn()
            const details = message.details as ReviewFeedbackDetails | undefined
            if (previous && details?.reviewId === previous.report.id) {
                const report = previous.report
                const ids = new Set([...previous.sent.map(s => s.id), ...details.items])
                previous.sent = [...ids].map(id => ({ id, title: itemTitle(report, id) }))
                previous.note = [previous.note, details.note].filter(Boolean).join('\n') || undefined
            }
        }
        else if (message.role === 'assistant') {
            const text = textOf(message.content).trim()
            if (text)
                turnReply = text
            if (previous?.sent.length && text)
                previous.replies.push(text)
            for (const block of message.content ?? []) {
                if (block?.type === 'toolCall' && (block.name === 'edit' || block.name === 'write')) {
                    const file = block.arguments?.path ?? block.arguments?.file_path
                    if (typeof file === 'string' && file)
                        files.add(path.resolve(cwd, file))
                }
            }
        }
    }
    endTurn()
    return {
        requests: fit(requests, MESSAGE_CLIP, MESSAGES_BUDGET),
        claims: fit(claims, MESSAGE_CLIP, CLAIMS_BUDGET),
        files: [...files],
        round,
        previous: previous?.sent.length ? { ...previous, replies: fit(previous.replies, MESSAGE_CLIP, CLAIMS_BUDGET) } : undefined,
    }
}

// ---------------------------------------------------------------- the reviewer's task

export interface Changes {
    scope: ReviewDetails['scope']
    /** Relative to the project when inside it. */
    files: string[]
    /** Unified diff (tracked) and new-file contents (untracked), within DIFF_BUDGET. */
    diff: string
    /** Files whose diff did not fit or that git cannot diff (outside the repo, not a repo). */
    unshown: string[]
}

const section = (title: string, body: string) => `## ${title}\n\n${body.trim()}\n`
const quote = (text: string) => text.split('\n').map(l => `> ${l}`).join('\n')

export function reviewerTask(facts: BranchFacts, changes: Changes, focus?: string): string {
    const parts: string[] = [
        'You are reviewing another agent\'s work in this project. You did not write it and you have not seen its reasoning; treat everything it claims as unverified until you check it.\n',
        section('What the user asked', facts.requests.length ? facts.requests.map(quote).join('\n\n') : '(no messages)'),
        section('What the agent says it did', facts.claims.length ? facts.claims.map(quote).join('\n\n') : '(no reply)'),
    ]
    const scope = changes.scope === 'thread'
        ? `The files this thread edited (${changes.files.length}), compared with git HEAD.`
        : changes.files.length ? `This thread made no edit/write calls, so this is every uncommitted change (${changes.files.length} files).` : 'No file changes were found. Check the agent\'s claims against the project instead.'
    let changeBody = `${scope}\n`
    if (changes.files.length)
        changeBody += `\nFiles:\n${changes.files.map(f => `- ${f}`).join('\n')}\n`
    if (changes.diff)
        changeBody += `\n\`\`\`diff\n${changes.diff}\n\`\`\`\n`
    if (changes.unshown.length)
        changeBody += `\nNot shown above (read these yourself, or run git diff on them):\n${changes.unshown.map(f => `- ${f}`).join('\n')}\n`
    parts.push(section('Changes to review', changeBody))
    if (facts.previous) {
        const p = facts.previous
        let body = `An earlier review (round ${p.report.round}) sent these items back to the agent:\n${p.sent.map(s => `- ${s.id}: ${s.title}`).join('\n')}\n`
        if (p.note)
            body += `\nThe user added: ${p.note}\n`
        body += `\nThe agent's replies since:\n${p.replies.length ? p.replies.map(quote).join('\n\n') : '(none)'}\n`
        body += '\nCheck each item against the code as it is now and record a recheck for it: fixed, not_fixed, rebuttal_accepted (the agent argued it does not apply and is right) or rebuttal_rejected.'
        parts.push(section('Previous review', body))
    }
    if (focus?.trim())
        parts.push(section('The user wants you to focus on', focus))
    parts.push(section('How to review', [
        '- Read the code around each change, not only the diff. Look for bugs, regressions, requirements from the user\'s messages that were missed, unhandled edge cases, and claims the code does not back up.',
        '- Verify by running things: the project\'s tests, type checker or build, or a small script that exercises the change. Put the exact command that shows a problem in the issue\'s `repro`; the report keeps that command\'s exit code and output as evidence. An issue without a command you ran is reported as suspected.',
        '- Do not change the project: no edits, commits, installs or deletions. Scratch files go in the system temp directory.',
        '- Report real problems only, with the file and line. Style is not a problem unless it causes one. If the work holds up, say so with verdict "pass" and no issues.',
        '- Suggestions are worthwhile follow-ups that are not defects: a missing test, a risky spot, a next step.',
        '- Write the report in the language the user writes in.',
        '- Finish by calling submit_review once.',
    ].join('\n')))
    return parts.join('\n')
}

// ---------------------------------------------------------------- evidence and the report

/** A bash result's exit code: the structured one, else the error text; undefined when it never finished. */
export function exitCodeOf(result: any, isError: boolean): number | undefined {
    const structured = result?.structuredContent?.exit_code
    if (typeof structured === 'number')
        return structured
    const match = /Command exited with code (-?\d+)/.exec(textOf(result?.content))
    if (match)
        return Number(match[1])
    return isError ? undefined : 0
}

export function evidenceOf(command: string, result: any, isError: boolean): ReviewEvidence {
    const output = textOf(result?.content).trimEnd()
    return {
        command,
        exitCode: exitCodeOf(result, isError),
        output: output.length > EVIDENCE_TAIL ? `…${output.slice(-EVIDENCE_TAIL)}` : output,
    }
}

const normalize = (command: string) => command.replace(/\s+/g, ' ').trim()

/** The latest command the reviewer ran that is, or contains, `repro`. */
export function matchEvidence(repro: string | undefined, commands: readonly ReviewEvidence[]): ReviewEvidence | undefined {
    const wanted = normalize(repro ?? '')
    if (!wanted)
        return undefined
    return commands.findLast(c => normalize(c.command) === wanted) ?? commands.findLast(c => normalize(c.command).includes(wanted))
}

/** What submit_review takes. */
export interface Submission {
    verdict: 'pass' | 'needs_work'
    summary: string
    issues?: { title: string, severity: ReviewSeverity, file?: string, line?: number, detail: string, fix?: string, repro?: string }[]
    suggestions?: { title: string, detail: string }[]
    rechecks?: { id: string, outcome: ReviewRecheck['outcome'], note: string }[]
}

export interface ReportInput {
    id: string
    round: number
    changes: Changes
    commands: ReviewEvidence[]
    run: SubagentDetails
    previous?: PreviousReview
}

export function buildReport(input: ReportInput, submission: Submission | undefined): ReviewDetails {
    const base = {
        kind: 'review' as const,
        id: input.id,
        round: input.round,
        files: input.changes.files,
        scope: input.changes.scope,
        commands: input.commands,
        run: input.run,
        startedAt: input.run.startedAt,
        endedAt: input.run.endedAt ?? Date.now(),
    }
    if (!submission) {
        return {
            ...base,
            status: input.run.status === 'cancelled' ? 'cancelled' : 'failed',
            summary: '',
            issues: [],
            suggestions: [],
            rechecks: [],
            error: input.run.error ?? 'The reviewer finished without submitting a report.',
        }
    }
    const issues: ReviewIssue[] = (submission.issues ?? []).map((issue, i) => {
        const evidence = matchEvidence(issue.repro, input.commands)
        return {
            id: `R${i + 1}`,
            title: issue.title,
            ...(issue.file ? { file: issue.file } : {}),
            ...(typeof issue.line === 'number' && issue.line > 0 ? { line: Math.floor(issue.line) } : {}),
            severity: issue.severity,
            detail: issue.detail,
            ...(issue.fix ? { fix: issue.fix } : {}),
            status: evidence ? 'confirmed' : 'suspected',
            ...(evidence ? { evidence } : {}),
        }
    })
    const suggestions: ReviewSuggestion[] = (submission.suggestions ?? []).map((s, i) => ({ id: `S${i + 1}`, title: s.title, detail: s.detail }))
    const sent = new Map((input.previous?.sent ?? []).map(s => [s.id, s.title]))
    const rechecks: ReviewRecheck[] = (submission.rechecks ?? []).filter(r => sent.has(r.id)).map(r => ({ id: r.id, title: sent.get(r.id)!, outcome: r.outcome, note: r.note }))
    return { ...base, status: 'done', verdict: submission.verdict, summary: submission.summary, issues, suggestions, rechecks }
}

// ---------------------------------------------------------------- back to the agent

const location = (issue: ReviewIssue) => issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : ''

/** The feedback message's text for the agent: the picked items with their evidence, and the note. */
export function feedbackText(report: ReviewDetails, apply: ReviewApply): string {
    const picked = new Set(apply.items)
    const issues = report.issues.filter(i => picked.has(i.id))
    const suggestions = report.suggestions.filter(s => picked.has(s.id))
    const lines = [
        `An independent reviewer checked your work (review ${report.round}) and the user picked these items for you. For each one, either fix it and verify the fix by running something, or explain why it does not apply. Answer item by item, using the ids.`,
    ]
    for (const issue of issues) {
        lines.push('', `### ${issue.id} [${issue.status}, ${issue.severity}] ${issue.title}`)
        if (location(issue))
            lines.push(`Where: ${location(issue)}`)
        lines.push(issue.detail)
        if (issue.fix)
            lines.push(`Suggested fix: ${issue.fix}`)
        if (issue.evidence) {
            const code = issue.evidence.exitCode === undefined ? 'did not finish' : `exited with ${issue.evidence.exitCode}`
            lines.push(`Reviewer ran \`${issue.evidence.command}\`, which ${code}:`, '```', issue.evidence.output || '(no output)', '```')
        }
    }
    for (const s of suggestions)
        lines.push('', `### ${s.id} [suggestion] ${s.title}`, s.detail)
    if (apply.note?.trim())
        lines.push('', `The user adds: ${apply.note.trim()}`)
    return lines.join('\n')
}

/** `R1 R3 extra words` → ids and note; no ids means every issue. */
export function parseApplyArgs(args: string, report: ReviewDetails): ReviewApply {
    const words = args.trim().split(/\s+/).filter(Boolean)
    const known = new Set([...report.issues.map(i => i.id), ...report.suggestions.map(s => s.id)])
    const items = words.map(w => w.toUpperCase()).filter(w => known.has(w))
    const note = words.filter(w => !known.has(w.toUpperCase())).join(' ')
    return { items: items.length ? [...new Set(items)] : report.issues.map(i => i.id), ...(note ? { note } : {}) }
}

/** The report as Markdown, for the terminal. */
export function reportMarkdown(report: ReviewDetails): string {
    if (report.status !== 'done')
        return `**Review ${report.status}**${report.error ? `: ${report.error}` : ''}`
    const lines = [`**Review ${report.round}: ${report.verdict === 'pass' ? 'pass' : 'needs work'}**`, '', report.summary]
    for (const r of report.rechecks)
        lines.push(`- ${r.id} ${r.title}: ${r.outcome.replace('_', ' ')}. ${r.note}`)
    for (const issue of report.issues) {
        lines.push('', `**${issue.id}** [${issue.status}, ${issue.severity}] ${issue.title}${location(issue) ? ` (${location(issue)})` : ''}`, issue.detail)
        if (issue.fix)
            lines.push(`Fix: ${issue.fix}`)
        if (issue.evidence)
            lines.push(`Evidence: \`${issue.evidence.command}\` → ${issue.evidence.exitCode ?? 'unfinished'}`)
    }
    for (const s of report.suggestions)
        lines.push('', `**${s.id}** ${s.title}`, s.detail)
    return lines.join('\n')
}
