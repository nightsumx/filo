// review: a second pi process audits this thread's changes and reports verified problems, without
// stopping or informing the agent until the user decides what goes back.
//   /gui-review [focus]                       start (one at a time); the GUI's Review button
//   /gui-review-apply <reviewId> <json>       send picked items (ReviewApply) to the agent
//   /gui-review-cancel                        stop a running review
//   /review [focus], /review-apply [R1 S2 …] [note]   the same from the terminal
// The reviewer gets facts only: the user's messages, the agent's final replies (as unverified
// claims), the diff of the files this thread edited (or every uncommitted change when it edited
// none), and on later rounds the items sent back with the agent's answers. It runs read-only (no
// edit/write) with this process's model and capabilities, and ends by calling submit_review. Every
// bash command it runs is recorded from its tool events; an issue whose `repro` matches one is
// confirmed with that command's exit code and output, anything else stays suspected.
// The report is a session entry (`pi.appendEntry`, outside the model's context); progress goes out
// as status `gui-review` (ReviewProgress JSON) in RPC mode and as plain status text in the terminal.
// Applying sends one custom message to the agent: it starts a turn when idle, or follows up.
// In the reviewer's own pi (PI_KIT_REVIEWER) this file registers submit_review and nothing else.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { GuiCommands, ReviewApply, ReviewDetails, ReviewEvidence, ReviewFeedbackDetails, ReviewProgress } from '../protocol'
import type { Submission } from '../lib/review'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { collectChanges } from '../lib/changes'
import { Child, childLaunch, finishRun, followApprovalMode, forwardDialog, newRun, recordEvent } from '../lib/child'
import { branchFacts, buildReport, evidenceOf, feedbackText, parseApplyArgs, REVIEW_TYPES, reportMarkdown, reviewerTask } from '../lib/review'
import { hang, oneLine } from '../tui/render'

const RUN_COMMAND: GuiCommands['review'] = 'gui-review'
const APPLY_COMMAND: GuiCommands['reviewApply'] = 'gui-review-apply'
const CANCEL_COMMAND: GuiCommands['reviewCancel'] = 'gui-review-cancel'
const STATUS = 'gui-review'
const TUI_STATUS = 'review'
const REVIEWER_ENV = 'PI_KIT_REVIEWER'
const SUBAGENT_ENV = 'PI_KIT_SUBAGENT'
const SUBMIT = 'submit_review'
const PROGRESS_INTERVAL = 500
const NUDGE = `Call ${SUBMIT} now with what you found so far.`

const SubmitParams = Type.Object({
    verdict: Type.Union([Type.Literal('pass'), Type.Literal('needs_work')], { description: 'pass: the work holds up; needs_work: at least one issue should be fixed' }),
    summary: Type.String({ description: 'Two or three sentences: what you checked and what you found' }),
    issues: Type.Optional(Type.Array(Type.Object({
        title: Type.String({ description: 'The problem in one line' }),
        severity: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')], { description: 'high: wrong behaviour or data loss; medium: a real bug in a less common path; low: minor' }),
        file: Type.Optional(Type.String({ description: 'Path relative to the project' })),
        line: Type.Optional(Type.Integer({ description: 'Line in the current file' })),
        detail: Type.String({ description: 'What goes wrong, when, and why' }),
        fix: Type.Optional(Type.String({ description: 'How to fix it' })),
        repro: Type.Optional(Type.String({ description: 'The exact bash command you ran that shows the problem' })),
    }))),
    suggestions: Type.Optional(Type.Array(Type.Object({
        title: Type.String(),
        detail: Type.String(),
    }), { description: 'Follow-ups that are not defects' })),
    rechecks: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ description: 'Item id from the previous review' }),
        outcome: Type.Union([Type.Literal('fixed'), Type.Literal('not_fixed'), Type.Literal('rebuttal_accepted'), Type.Literal('rebuttal_rejected')]),
        note: Type.String({ description: 'What you checked' }),
    }), { description: 'One per item the previous review sent back' })),
})

/** The reviewer's side: the report tool, which ends its run. */
function reviewer(pi: ExtensionAPI) {
    pi.registerTool({
        name: SUBMIT,
        label: 'Submit review',
        description: 'Submit your review report. Call it once, at the end.',
        parameters: SubmitParams,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        async execute() {
            return { content: [{ type: 'text', text: 'Report received.' }], details: undefined, terminate: true }
        },
    })
}

/** This file, for the reviewer's `-e`: the module URL, or the path this process was given. */
function selfPath(): string {
    try {
        return fileURLToPath(import.meta.url)
    }
    catch {
        const argv = process.argv
        const i = argv.findIndex((a, j) => (argv[j - 1] === '-e' || argv[j - 1] === '--extension') && path.basename(a) === 'review.ts')
        return i >= 0 ? argv[i] : path.join(path.dirname(process.argv[1] ?? ''), 'review.ts')
    }
}

interface Active {
    id: string
    cancel: () => void
}

function host(pi: ExtensionAPI) {
    const approvalMode = followApprovalMode(pi)
    let active: Active | undefined

    const reportOf = (ctx: ExtensionContext, id?: string): ReviewDetails | undefined => {
        const reports = ctx.sessionManager.getBranch().filter((e: any) => e.type === 'custom' && e.customType === REVIEW_TYPES.report && e.data?.status === 'done').map((e: any) => e.data as ReviewDetails)
        return id ? reports.find(r => r.id === id) : reports.at(-1)
    }

    async function run(ctx: ExtensionCommandContext, focus: string) {
        if (active)
            return ctx.ui.notify('审查已经在进行中', 'warning')
        const id = `rv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        const startedAt = Date.now()
        const rpc = ctx.mode === 'rpc'
        let tools = 0
        let last: string | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let publishedAt = 0
        const publish = () => {
            timer = undefined
            publishedAt = Date.now()
            if (rpc) {
                const progress: ReviewProgress = { id, startedAt, tools, ...(last ? { last } : {}) }
                ctx.ui.setStatus(STATUS, JSON.stringify(progress))
            }
            else {
                ctx.ui.setStatus(TUI_STATUS, `Reviewing · ${tools} tool${tools === 1 ? '' : 's'}${last ? ` · ${last}` : ''}`)
            }
        }
        const changed = () => {
            timer ??= setTimeout(publish, Math.max(0, publishedAt + PROGRESS_INTERVAL - Date.now()))
        }
        let cancelled = false
        let child: Child | undefined
        active = {
            id,
            cancel: () => {
                cancelled = true
                child?.stop()
            },
        }
        publish()

        try {
            const facts = branchFacts(ctx.sessionManager.getBranch(), ctx.cwd)
            const changes = await collectChanges(pi, ctx.cwd, facts.files)
            if (cancelled)
                return
            const task = reviewerTask(facts, changes, focus)
            const launch = childLaunch(pi, ctx, approvalMode(), ['--exclude-tools', 'edit,write', '-e', selfPath()])
            const details = newRun('Review', task, ctx)
            const proc = new Child(launch.args, ctx.cwd, { ...launch.env, [REVIEWER_ENV]: '1', [SUBAGENT_ENV]: '1' })
            child = proc
            const commands: ReviewEvidence[] = []
            const calls = new Map<string, { name: string, args: any }>()
            let submission: Submission | undefined
            let settle: () => void = () => {}
            const settled = () => new Promise<void>((resolve) => {
                settle = resolve
            })

            proc.onEvent = (event) => {
                if (event.type === 'extension_ui_request') {
                    void forwardDialog(proc, 'Review', event, ctx).catch(() => proc.send({ type: 'extension_ui_response', id: event.id, cancelled: true }))
                    return
                }
                if (event.type === 'agent_settled')
                    return settle()
                if (event.type === 'tool_execution_start') {
                    calls.set(event.toolCallId, { name: event.toolName, args: event.args })
                    if (event.toolName !== SUBMIT) {
                        tools++
                        const main = event.args?.command ?? event.args?.path ?? event.args?.pattern
                        last = typeof main === 'string' ? `${event.toolName} ${oneLine(main, 60)}` : event.toolName
                        changed()
                    }
                }
                if (event.type === 'tool_execution_end') {
                    const call = calls.get(event.toolCallId)
                    if (call?.name === 'bash' && typeof call.args?.command === 'string')
                        commands.push(evidenceOf(call.args.command, event.result, event.isError))
                    if (call?.name === SUBMIT && !event.isError)
                        submission = call.args
                }
                recordEvent(details, event)
            }
            proc.onExit = (error) => {
                if (details.status === 'running' && !cancelled) {
                    details.status = 'failed'
                    details.error = error || 'The reviewer process exited.'
                }
                settle()
            }

            let wait = settled()
            const prompt = await proc.request({ type: 'prompt', message: task })
            if (!prompt.success) {
                details.status = 'failed'
                details.error = prompt.error ?? 'The reviewer rejected the task.'
            }
            else {
                await wait
                // One reminder when it stopped without reporting.
                if (!submission && !cancelled && !proc.exited && details.status === 'running') {
                    wait = settled()
                    const nudged = await proc.request({ type: 'prompt', message: NUDGE })
                    if (nudged.success)
                        await wait
                }
            }
            proc.stop()
            if (cancelled)
                details.status = 'cancelled'
            finishRun(details)
            if (cancelled)
                return
            const report = buildReport({ id, round: facts.round, changes, commands, run: details, previous: facts.previous }, submission)
            pi.appendEntry(REVIEW_TYPES.report, report)
            if (report.status === 'failed')
                ctx.ui.notify(`审查失败：${report.error}`, 'error')
        }
        catch (error) {
            ctx.ui.notify(`审查失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        }
        finally {
            if (timer)
                clearTimeout(timer)
            if (active?.id === id)
                active = undefined
            ctx.ui.setStatus(rpc ? STATUS : TUI_STATUS, undefined)
        }
    }

    function apply(ctx: ExtensionContext, report: ReviewDetails, choice: ReviewApply) {
        const known = new Set([...report.issues.map(i => i.id), ...report.suggestions.map(s => s.id)])
        const items = choice.items.filter(i => known.has(i))
        if (!items.length && !choice.note?.trim())
            return ctx.ui.notify('没有选中任何条目', 'warning')
        const apply: ReviewApply = { items, ...(choice.note?.trim() ? { note: choice.note.trim() } : {}) }
        const details: ReviewFeedbackDetails = { reviewId: report.id, ...apply }
        pi.sendMessage(
            { customType: REVIEW_TYPES.feedback, content: feedbackText(report, apply), display: true, details },
            ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: 'followUp' },
        )
    }

    // Runs in the background: the command returns at once, so the agent and the input stay free.
    pi.registerCommand(RUN_COMMAND, {
        description: 'Internal: start a review',
        handler: async (args, ctx) => {
            void run(ctx, args)
        },
    })
    pi.registerCommand('review', {
        description: 'Review this thread\'s changes in a separate read-only agent',
        handler: async (args, ctx) => {
            void run(ctx, args)
        },
    })
    pi.registerCommand(CANCEL_COMMAND, {
        description: 'Internal: stop the running review',
        handler: async (_args, ctx) => {
            if (!active)
                return ctx.ui.notify('没有正在进行的审查', 'warning')
            active.cancel()
        },
    })
    pi.registerCommand(APPLY_COMMAND, {
        description: 'Internal: send picked review items to the agent',
        handler: async (args, ctx) => {
            const space = args.indexOf(' ')
            const id = space < 0 ? args.trim() : args.slice(0, space)
            const report = reportOf(ctx, id)
            if (!report)
                return ctx.ui.notify('找不到这份审查报告', 'warning')
            let choice: ReviewApply
            try {
                const parsed = JSON.parse(args.slice(space + 1))
                choice = { items: Array.isArray(parsed?.items) ? parsed.items.filter((i: unknown) => typeof i === 'string') : [], note: typeof parsed?.note === 'string' ? parsed.note : undefined }
            }
            catch {
                return ctx.ui.notify('审查回填参数无效', 'error')
            }
            apply(ctx, report, choice)
        },
    })
    pi.registerCommand('review-apply', {
        description: 'Send the latest review\'s items to the agent: /review-apply [R1 S2 …] [note]; no ids sends every issue',
        handler: async (args, ctx) => {
            const report = reportOf(ctx)
            if (!report)
                return ctx.ui.notify('还没有审查报告，先运行 /review', 'warning')
            apply(ctx, report, parseApplyArgs(args, report))
        },
    })

    pi.registerEntryRenderer<ReviewDetails>(REVIEW_TYPES.report, (entry) => {
        if (!entry.data)
            return undefined
        return new Markdown(reportMarkdown(entry.data), 0, 0, getMarkdownTheme())
    })
    pi.registerMessageRenderer<ReviewFeedbackDetails>(REVIEW_TYPES.feedback, (message, options, theme) => {
        const n = message.details?.items.length ?? 0
        const head = `${theme.fg('accent', '⏺')} ${theme.bold('Review feedback')}(${n} item${n === 1 ? '' : 's'})`
        if (!options.expanded)
            return new Text(head, 0, 0)
        const body = typeof message.content === 'string' ? message.content : message.content.map(c => c.type === 'text' ? c.text : '').join('')
        const container = new Container()
        container.addChild(new Text(head, 0, 0))
        container.addChild(hang(theme, body.split('\n')))
        return container
    })

    pi.on('session_shutdown', async () => {
        active?.cancel()
        active = undefined
    })
}

export default function (pi: ExtensionAPI) {
    if (process.env[REVIEWER_ENV])
        return reviewer(pi)
    // An ordinary subagent's pi: reviews belong to the session the user talks to.
    if (process.env[SUBAGENT_ENV])
        return
    host(pi)
}
