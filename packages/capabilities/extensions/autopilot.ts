// autopilot: a supervisor answers the agent in the user's place, so the user can step away.
//   /gui-autopilot on|off                        the app's switch
//   /gui-autopilot-answer <cardId> <json>        the user decides a card (AutopilotAnswer)
//   /gui-autopilot-learn                         propose rulebook changes from recorded interventions
//   /autopilot [on|off|inbox|learn]              the same in the terminal; bare toggles; /inbox lists
//                                                every session's waiting cards
// While on:
// - Hard rules: before a call runs, pushing, deploying, publishing, paid generation APIs, deleting
//   what git or this session cannot bring back, sudo and printing secrets are held. The call is
//   blocked with a reason, and a gate card asks the user; "allow" grants that kind for the session.
// - When a run settles, a read-only second pi (this file, PI_KIT_AUTOPILOT_SUPERVISOR) gets the
//   user's rulebook, the conversation, the agent's last reply and commands, the diff, the cards and the
//   other sessions in the same project. It may run checks, then calls submit_decision: continue with
//   a message (sent as the user would type it), wait for cards, or done. Cards are what only the user
//   decides; answering one tells the agent.
// - Safety valves stop it: the same rule three times in a row, or two runs in which the agent did
//   nothing. API errors are retried three times without asking the supervisor.
// - The ask tool is off (the agent decides or lists options), and the agent gets instructions for
//   working unattended.
// Every running pi with autopilot loaded keeps a board file and a mailbox under
// `<agent dir>/autopilot` (protocol.ts): supervisors see the sessions working in the same project and
// leave each other notes; the terminal inbox answers any session's cards. What the user types while
// autopilot is on is recorded as a miss; /autopilot learn turns misses into a proposed rulebook, which
// is itself a card.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { AutopilotAnswer, AutopilotAnswerEntry, AutopilotCard, AutopilotDecision, AutopilotMessageDetails, AutopilotPeer, AutopilotPhase, AutopilotStatus, GuiCommands, ReviewEvidence, SubagentDetails } from '../protocol'
import type { FileState, GitFacts, Submission } from '../lib/autopilot'
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Container, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { answerText, AUTOPILOT_TYPES, autopilotDir, autopilotFacts, cardsOf, gateCard, gateOf, gateReason, isAngry, lastLearned, learnTask, mailDir, newId, readConfig, readMisses, readPeers, readRules, recordMiss, removePeer, sendMail, SUPERVISOR_DIFF_BUDGET, supervisorBlocks, supervisorTask, takeMail, valveOf, WORKER_INSTRUCTIONS, writePeer, writeRules } from '../lib/autopilot'
import { collectChanges } from '../lib/changes'
import { Child, childLaunch, clip, finishRun, forwardDialog, newRun, recordEvent } from '../lib/child'
import { isReadOnlyCommand } from '../lib/readonly'
import { evidenceOf } from '../lib/review'
import { choose, serialized } from '../tui/dialog'
import { hang, oneLine } from '../tui/render'

const COMMAND: GuiCommands['autopilot'] = 'gui-autopilot'
const ANSWER_COMMAND: GuiCommands['autopilotAnswer'] = 'gui-autopilot-answer'
const LEARN_COMMAND: GuiCommands['autopilotLearn'] = 'gui-autopilot-learn'
const STATUS = 'gui-autopilot'
const TUI_STATUS = 'autopilot'
const SUPERVISOR_ENV = 'PI_KIT_AUTOPILOT_SUPERVISOR'
const LEARNER_ENV = 'PI_KIT_AUTOPILOT_LEARNER'
const SUBAGENT_ENV = 'PI_KIT_SUBAGENT'
const SUBMIT = 'submit_decision'
const SUBMIT_RULES = 'submit_rules'
const NUDGE = (tool: string) => `Call ${tool} now with what you have.`
const PROGRESS_INTERVAL = 500
/** API errors in a row retried before a card; waits grow with each. */
const RETRIES = 3
const RETRY_DELAY = 10_000
const LAST_CLIP = 400

const OptionParams = Type.Object({
    id: Type.Optional(Type.String({ description: 'Short id; A, B, C… when omitted' })),
    label: Type.String({ description: 'The choice in a few words' }),
    detail: Type.Optional(Type.String({ description: 'What it means or costs' })),
})

const DecisionParams = Type.Object({
    next: Type.Union([Type.Literal('continue'), Type.Literal('wait'), Type.Literal('done')], { description: 'continue: send `message` to the agent. wait: nothing can move until the user answers the cards. done: the goal is met and verified' }),
    message: Type.Optional(Type.String({ description: 'For continue: what the user would type to the agent now' })),
    reason: Type.String({ description: 'One or two sentences: what you checked and why this decision' }),
    rules: Type.Optional(Type.Array(Type.String(), { description: 'Rulebook ids this rests on, e.g. R05' })),
    topic: Type.Optional(Type.String({ description: 'What this thread works on, a few words' })),
    cards: Type.Optional(Type.Array(Type.Object({
        category: Type.Optional(Type.String({ description: 'taste, direction, money, release, delete, naming, theory or other' })),
        title: Type.String({ description: 'The decision in a few words' }),
        question: Type.String({ description: 'What the user is asked, with the context they need' }),
        options: Type.Array(OptionParams, { description: '2 to 6 options' }),
        recommended: Type.Optional(Type.String({ description: 'Id of the option you recommend' })),
        fallback: Type.Optional(Type.String({ description: 'What happens while nobody answers: the safe choice' })),
        evidence: Type.Optional(Type.Array(Type.String(), { description: 'Absolute paths of screenshots, contact sheets or files to look at' })),
    }), { description: 'Decisions only the user makes' })),
    peers: Type.Optional(Type.Array(Type.Object({
        session: Type.String({ description: 'Session id from "Other sessions"' }),
        text: Type.String({ description: 'The note, as one agent to another' }),
    }), { description: 'Notes for other sessions in the same project' })),
})

const RulesParams = Type.Object({
    rules: Type.String({ description: 'The complete new rulebook in Markdown' }),
    summary: Type.String({ description: 'What changed and why, a few lines' }),
})

/** This file, for the children's `-e`: the module URL, or the path this process was given. */
function selfPath(): string {
    try {
        return fileURLToPath(import.meta.url)
    }
    catch {
        const argv = process.argv
        const i = argv.findIndex((a, j) => (argv[j - 1] === '-e' || argv[j - 1] === '--extension') && path.basename(a) === 'autopilot.ts')
        return i >= 0 ? argv[i] : path.join(path.dirname(process.argv[1] ?? ''), 'autopilot.ts')
    }
}

/** The supervisor's pi: the decision tool, and bash without the commands it may not run. */
function supervisor(pi: ExtensionAPI) {
    pi.registerTool({
        name: SUBMIT,
        label: 'Submit decision',
        description: 'Submit your decision. Call it once, at the end.',
        parameters: DecisionParams,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        async execute() {
            return { content: [{ type: 'text', text: 'Decision received.' }], details: undefined, terminate: true }
        },
    })
    pi.on('tool_call', async (event) => {
        if (event.toolName !== 'bash')
            return undefined
        const why = supervisorBlocks(String((event.input as any).command ?? ''))
        return why ? { block: true, reason: `Blocked: ${why}.` } : undefined
    })
}

/** The learner's pi: the rulebook tool, and read-only bash. */
function learner(pi: ExtensionAPI) {
    pi.registerTool({
        name: SUBMIT_RULES,
        label: 'Submit rules',
        description: 'Submit the new rulebook. Call it once, at the end.',
        parameters: RulesParams,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        async execute() {
            return { content: [{ type: 'text', text: 'Rules received.' }], details: undefined, terminate: true }
        },
    })
    pi.on('tool_call', async (event) => {
        if (event.toolName === 'bash' && !isReadOnlyCommand(String((event.input as any).command ?? '')))
            return { block: true, reason: 'Only read-only commands here.' }
        return undefined
    })
}

interface ChildResult<T> {
    submission?: T
    run: SubagentDetails
    commands: ReviewEvidence[]
}

/** The supervisor's or learner's run: a second pi over RPC that ends by calling `submit`. */
async function runChild<T>(pi: ExtensionAPI, ctx: ExtensionContext, opts: { title: string, task: string, submit: string, env: Record<string, string>, exclude: string, signal: { cancelled: boolean, stop?: () => void }, onTool?: (tools: number, last: string) => void }): Promise<ChildResult<T>> {
    const launch = childLaunch(pi, ctx, 'auto', ['--exclude-tools', opts.exclude])
    // Without this file among the parent's -e (pi-cc-tui loads it as a package), the child gets it below.
    const args: string[] = []
    for (let i = 0; i < launch.args.length; i++) {
        if ((launch.args[i] === '-e' || launch.args[i] === '--extension') && path.basename(launch.args[i + 1] ?? '') === 'autopilot.ts') {
            i++
            continue
        }
        args.push(launch.args[i])
    }
    args.push('-e', selfPath())
    const run = newRun(opts.title, opts.task, ctx)
    const proc = new Child(args, ctx.cwd, { ...launch.env, ...opts.env, [SUBAGENT_ENV]: '1' })
    opts.signal.stop = () => proc.stop()
    const commands: ReviewEvidence[] = []
    const calls = new Map<string, { name: string, args: any }>()
    let submission: T | undefined
    let tools = 0
    let settle: () => void = () => {}
    const settled = () => new Promise<void>((resolve) => {
        settle = resolve
    })
    proc.onEvent = (event) => {
        if (event.type === 'extension_ui_request') {
            void forwardDialog(proc, opts.title, event, ctx).catch(() => proc.send({ type: 'extension_ui_response', id: event.id, cancelled: true }))
            return
        }
        if (event.type === 'agent_settled')
            return settle()
        if (event.type === 'tool_execution_start') {
            calls.set(event.toolCallId, { name: event.toolName, args: event.args })
            if (event.toolName !== opts.submit) {
                tools++
                const main = event.args?.command ?? event.args?.path ?? event.args?.pattern
                opts.onTool?.(tools, typeof main === 'string' ? `${event.toolName} ${oneLine(main, 60)}` : event.toolName)
            }
        }
        if (event.type === 'tool_execution_end') {
            const call = calls.get(event.toolCallId)
            if (call?.name === 'bash' && typeof call.args?.command === 'string')
                commands.push(evidenceOf(call.args.command, event.result, event.isError))
            if (call?.name === opts.submit && !event.isError)
                submission = call.args
        }
        recordEvent(run, event)
    }
    proc.onExit = (error) => {
        if (run.status === 'running' && !opts.signal.cancelled) {
            run.status = 'failed'
            run.error = error || 'The process exited.'
        }
        settle()
    }
    let wait = settled()
    const prompt = await proc.request({ type: 'prompt', message: opts.task })
    if (!prompt.success) {
        run.status = 'failed'
        run.error = prompt.error ?? 'The task was rejected.'
    }
    else {
        await wait
        if (!submission && !opts.signal.cancelled && !proc.exited && run.status === 'running') {
            wait = settled()
            const nudged = await proc.request({ type: 'prompt', message: NUDGE(opts.submit) })
            if (nudged.success)
                await wait
        }
    }
    proc.stop()
    if (opts.signal.cancelled)
        run.status = 'cancelled'
    finishRun(run)
    return { submission, run, commands }
}

function host(pi: ExtensionAPI) {
    const agentDir = getAgentDir()
    let on = false
    let phase: AutopilotPhase = 'off'
    let since = Date.now()
    let running = false
    let tools: number | undefined
    let last: string | undefined
    let active: { cancelled: boolean, stop?: () => void } | undefined
    let current: ExtensionContext | undefined
    let session = ''
    let root = ''
    let topic: string | undefined
    let watcher: ReturnType<typeof watch> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let publishTimer: ReturnType<typeof setTimeout> | undefined
    let publishedAt = 0
    let askHidden = false
    const created = new Set<string>()

    const facts = (ctx: ExtensionContext) => autopilotFacts(ctx.sessionManager.getBranch(), ctx.cwd)

    function setPhase(next: AutopilotPhase) {
        if (next !== phase) {
            phase = next
            since = Date.now()
        }
    }

    /** Status for the host and the board entry; at most every PROGRESS_INTERVAL while supervising. */
    function publish(ctx: ExtensionContext, now = false) {
        if (!now) {
            publishTimer ??= setTimeout(() => publish(ctx, true), Math.max(0, publishedAt + PROGRESS_INTERVAL - Date.now()))
            return
        }
        if (publishTimer)
            clearTimeout(publishTimer)
        publishTimer = undefined
        publishedAt = Date.now()
        const f = facts(ctx)
        const status: AutopilotStatus = { phase, since, decisions: f.decisions.length, pending: f.pending.length, ...(phase === 'supervising' && tools !== undefined ? { tools } : {}), ...(phase === 'supervising' && last ? { last } : {}) }
        if (ctx.mode === 'rpc') {
            ctx.ui.setStatus(STATUS, JSON.stringify(status))
        }
        else if (phase === 'off') {
            ctx.ui.setStatus(TUI_STATUS, f.pending.length ? `${f.pending.length} card${f.pending.length === 1 ? '' : 's'} waiting · /inbox` : undefined)
        }
        else {
            const what = phase === 'supervising' ? `supervising${tools ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : ''}${last ? ` · ${last}` : ''}` : phase === 'waiting' ? 'waiting for you' : 'on'
            ctx.ui.setStatus(TUI_STATUS, `Autopilot · ${what}${f.pending.length ? ` · ${f.pending.length} card${f.pending.length === 1 ? '' : 's'} · /inbox` : ''}`)
        }
        if (session) {
            const peer: AutopilotPeer = {
                session,
                pid: process.pid,
                cwd: ctx.cwd,
                root,
                file: ctx.sessionManager.getSessionFile(),
                ...(topic ? { topic } : {}),
                state: running ? 'running' : phase,
                files: f.files,
                cards: f.pending.map(c => ({ id: c.id, category: c.category, title: c.title, question: c.question, options: c.options, ...(c.recommended ? { recommended: c.recommended } : {}) })),
                ...(f.reply ? { last: clip(f.reply, LAST_CLIP) } : {}),
                updatedAt: Date.now(),
            }
            writePeer(agentDir, peer)
        }
    }

    /** The ask tool is off while autopilot is on: nobody is there to answer. */
    function applyTools() {
        const active = pi.getActiveTools()
        if (on && active.includes('ask')) {
            pi.setActiveTools(active.filter(t => t !== 'ask'))
            askHidden = true
        }
        else if (!on && askHidden) {
            if (pi.getAllTools().some(t => t.name === 'ask') && !active.includes('ask'))
                pi.setActiveTools([...active, 'ask'])
            askHidden = false
        }
    }

    function setOn(next: boolean, ctx: ExtensionContext) {
        if (next !== on) {
            on = next
            pi.appendEntry(AUTOPILOT_TYPES.mode, { on })
        }
        if (!on) {
            active?.stop?.()
            if (active)
                active.cancelled = true
            if (retryTimer)
                clearTimeout(retryTimer)
            retryTimer = undefined
            setPhase('off')
        }
        else if (phase === 'off') {
            setPhase(facts(ctx).pending.length ? 'waiting' : 'idle')
        }
        applyTools()
        publish(ctx, true)
        // Switched on while idle with something to judge: judge it now.
        if (on && ctx.isIdle() && !active && facts(ctx).log.some(l => l.who === 'agent'))
            void supervise(ctx)
    }

    /** A message to the agent in the user's place: starts a turn when idle, follows up otherwise. */
    function tell(ctx: ExtensionContext, text: string, details: AutopilotMessageDetails) {
        pi.sendMessage<AutopilotMessageDetails>(
            { customType: AUTOPILOT_TYPES.message, content: text, display: true, details },
            ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: 'followUp' },
        )
    }

    function addCards(cards: AutopilotCard[]) {
        for (const card of cards)
            pi.appendEntry(AUTOPILOT_TYPES.card, card)
        if (cards.length && current)
            current.ui.notify(`Autopilot：${cards.length} 张卡片等你决定（${cards.map(c => c.title).join('；')}）`, 'info')
    }

    async function gitFacts(ctx: ExtensionContext): Promise<GitFacts | undefined> {
        const git = (...args: string[]) => pi.exec('git', args, { cwd: ctx.cwd, timeout: 10_000 })
        const status = await git('status', '--short')
        if (status.code !== 0)
            return undefined
        const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim() || undefined
        const time = Number((await git('log', '-1', '--format=%ct')).stdout.trim())
        const ahead = Number((await git('rev-list', '--count', '@{u}..HEAD')).stdout.trim())
        return {
            branch,
            status: status.stdout.split('\n').filter(Boolean),
            ...(time ? { sinceCommit: Math.round((Date.now() / 1000 - time) / 60) } : {}),
            ...(Number.isFinite(ahead) && ahead > 0 ? { ahead } : {}),
        }
    }

    async function supervise(ctx: ExtensionContext) {
        if (!on || active || !ctx.isIdle() || ctx.hasPendingMessages())
            return
        const before = facts(ctx)
        // The user stopped the run themselves: they are here.
        if (before.run.stopReason === 'aborted') {
            setPhase(before.pending.length ? 'waiting' : 'idle')
            return publish(ctx, true)
        }
        if (before.run.stopReason === 'error') {
            if (before.errors <= RETRIES) {
                retryTimer = setTimeout(() => {
                    retryTimer = undefined
                    if (on && ctx.isIdle())
                        tell(ctx, '继续', { from: 'retry' })
                }, RETRY_DELAY * before.errors)
                return
            }
            addCards([{ kind: 'autopilot-card', id: newId('card'), category: 'other', title: '接口连续出错', question: `已经自动重试 ${RETRIES} 次：${before.run.error ?? '未知错误'}`, options: [{ id: 'go', label: '再试一次' }, { id: 'stop', label: '先停' }], fallback: '保持暂停', held: '继续', createdAt: Date.now() }])
            setPhase('waiting')
            return publish(ctx, true)
        }

        const signal: { cancelled: boolean, stop?: () => void } = { cancelled: false }
        active = signal
        tools = 0
        last = undefined
        setPhase('supervising')
        publish(ctx, true)
        const id = newId('ap')
        const startedAt = Date.now()
        try {
            const [changes, git] = await Promise.all([collectChanges(pi, ctx.cwd, before.files, SUPERVISOR_DIFF_BUDGET), gitFacts(ctx)])
            const peers = readPeers(agentDir).filter(p => p.session !== session && p.root === root)
            const task = supervisorTask({ facts: before, changes, git, peers, rules: readRules(agentDir, ctx.cwd), session, cwd: ctx.cwd })
            if (signal.cancelled)
                return
            const result = await runChild<Submission>(pi, ctx, {
                title: 'Autopilot',
                task,
                submit: SUBMIT,
                env: { [SUPERVISOR_ENV]: '1' },
                exclude: 'edit,write',
                signal,
                onTool: (n, l) => {
                    tools = n
                    last = l
                    publish(ctx)
                },
            })
            if (signal.cancelled || !on)
                return
            const submission = result.submission
            const base = { kind: 'autopilot' as const, id, commands: result.commands, run: result.run, startedAt, endedAt: Date.now(), workTools: before.run.tools }
            if (!submission) {
                const decision: AutopilotDecision = { ...base, status: 'failed', next: 'wait', reason: '', rules: [], cards: [], error: result.run.error ?? 'The supervisor finished without a decision.' }
                pi.appendEntry(AUTOPILOT_TYPES.decision, decision)
                ctx.ui.notify(`Autopilot 监督失败：${decision.error}`, 'error')
                setPhase(before.pending.length ? 'waiting' : 'idle')
                return
            }
            const after = facts(ctx)
            const cards = cardsOf(submission)
            const valve = valveOf(submission, before.run.tools, after.decisions)
            if (valve)
                cards.push(valve.card)
            const next = valve ? 'wait' : submission.next === 'continue' && !submission.message?.trim() ? 'wait' : submission.next
            const peerNotes = (submission.peers ?? []).filter(p => p.text?.trim() && peers.some(x => x.session === p.session))
            if (submission.topic?.trim())
                topic = clip(submission.topic.trim(), 80)
            addCards(cards)
            const decision: AutopilotDecision = {
                ...base,
                status: 'done',
                next,
                ...(next === 'continue' ? { message: submission.message!.trim() } : {}),
                reason: submission.reason ?? '',
                rules: (submission.rules ?? []).filter(r => typeof r === 'string'),
                cards: cards.map(c => c.id),
                ...(valve ? { valve: valve.valve } : {}),
                ...(topic ? { topic } : {}),
                ...(peerNotes.length ? { peers: peerNotes } : {}),
            }
            pi.appendEntry(AUTOPILOT_TYPES.decision, decision)
            for (const note of peerNotes)
                sendMail(agentDir, note.session, { kind: 'note', from: `${session}${topic ? `（${topic}）` : ''}`, text: note.text, at: Date.now() })
            // The user typed while the supervisor worked: theirs goes first, this one is dropped.
            if (!ctx.isIdle() || ctx.hasPendingMessages())
                return
            if (next === 'continue')
                tell(ctx, decision.message!, { from: 'supervisor', decisionId: id, rules: decision.rules })
            else if (next === 'done')
                ctx.ui.notify(`Autopilot：做完了。${decision.reason}`, 'info')
            setPhase(next === 'continue' ? 'idle' : facts(ctx).pending.length ? 'waiting' : 'idle')
        }
        catch (error) {
            ctx.ui.notify(`Autopilot 监督失败：${error instanceof Error ? error.message : String(error)}`, 'error')
            setPhase('idle')
        }
        finally {
            if (active === signal)
                active = undefined
            tools = undefined
            last = undefined
            if (on && phase === 'supervising')
                setPhase('idle')
            publish(ctx, true)
        }
    }

    /** The user decided a card of this session. */
    function answer(ctx: ExtensionContext, card: AutopilotCard, value: AutopilotAnswer, via: AutopilotAnswerEntry['via']) {
        const entry: AutopilotAnswerEntry = { cardId: card.id, ...(value.choice ? { choice: value.choice } : {}), ...(value.text?.trim() ? { text: value.text.trim() } : {}), via, at: Date.now() }
        pi.appendEntry(AUTOPILOT_TYPES.answer, entry)
        const label = card.options.find(o => o.id === value.choice)?.label ?? value.choice ?? ''
        recordMiss(agentDir, { at: Date.now(), cwd: ctx.cwd, session, text: `[卡片] ${card.title}：${card.question} → ${[label, entry.text].filter(Boolean).join('；')}`, phase })
        if (card.category === 'rules') {
            if (value.choice === 'apply' && card.rules) {
                const backup = writeRules(agentDir, card.rules.text)
                ctx.ui.notify(`规则库已更新，旧版在 ${backup}`, 'info')
            }
        }
        else if (card.held) {
            if (value.choice === 'go')
                tell(ctx, value.text?.trim() ? `${card.held}\n\n${value.text.trim()}` : card.held, { from: 'user' })
            else
                setOn(false, ctx)
        }
        else {
            tell(ctx, answerText(card, entry), { from: 'user' })
        }
        if (on && phase === 'waiting' && !facts(ctx).pending.length)
            setPhase('idle')
        publish(ctx, true)
    }

    function answerById(ctx: ExtensionContext, cardId: string, value: AutopilotAnswer, via: AutopilotAnswerEntry['via']): boolean {
        const card = facts(ctx).pending.find(c => c.id === cardId)
        if (!card)
            return false
        answer(ctx, card, value, via)
        return true
    }

    function readMail(ctx: ExtensionContext) {
        if (!session)
            return
        for (const mail of takeMail(agentDir, session)) {
            if (mail.kind === 'answer') {
                answerById(ctx, mail.cardId, mail.answer, 'mail')
            }
            else if (on) {
                tell(ctx, `另一个会话（${mail.from}）的监督者提醒：${mail.text}`, { from: 'peer' })
            }
            else {
                pi.sendMessage<AutopilotMessageDetails>({ customType: AUTOPILOT_TYPES.message, content: `另一个会话（${mail.from}）的监督者提醒：${mail.text}`, display: true, details: { from: 'peer' } }, { deliverAs: 'nextTurn' })
            }
        }
    }

    async function fileState(ctx: ExtensionContext, file: string): Promise<FileState> {
        if (!existsSync(file))
            return 'missing'
        if (!root || path.relative(root, file).startsWith('..'))
            return 'outside'
        const status = await pi.exec('git', ['status', '--porcelain', '--ignored', '--', file], { cwd: ctx.cwd, timeout: 10_000 })
        if (status.code !== 0)
            return 'untracked'
        const lines = status.stdout.split('\n').filter(Boolean)
        if (!lines.length)
            return 'clean'
        if (lines.every(l => l.startsWith('!!')))
            return 'ignored'
        return lines.some(l => l.startsWith('??')) ? 'untracked' : 'dirty'
    }

    // ------------------------------------------------------------ events

    pi.on('session_start', async (_event, ctx) => {
        current = ctx
        session = ctx.sessionManager.getSessionId()
        const top = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd: ctx.cwd, timeout: 10_000 }).catch(() => undefined)
        root = top?.code === 0 ? top.stdout.trim() : ctx.cwd
        const f = facts(ctx)
        on = f.on
        topic = f.decisions.findLast(d => d.topic)?.topic
        setPhase(on ? (f.pending.length ? 'waiting' : 'idle') : 'off')
        applyTools()
        try {
            const dir = mailDir(agentDir, session)
            mkdirSync(dir, { recursive: true })
            watcher = watch(dir, () => current && readMail(current))
            watcher.on('error', () => {})
        }
        catch {}
        readMail(ctx)
        publish(ctx, true)
    })

    pi.on('before_agent_start', async (event) => {
        if (on)
            event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, autopilot: WORKER_INSTRUCTIONS }
    })

    pi.on('agent_start', async (_event, ctx) => {
        running = true
        publish(ctx)
    })

    pi.on('agent_settled', async (_event, ctx) => {
        running = false
        current = ctx
        readMail(ctx)
        publish(ctx, true)
        if (on)
            setTimeout(() => void supervise(ctx), 0)
    })

    pi.on('tool_call', async (event, ctx) => {
        if (!on)
            return undefined
        const input = event.input as any
        const gate = await gateOf(event.toolName, input, {
            cwd: ctx.cwd,
            config: readConfig(agentDir),
            created,
            fileState: file => fileState(ctx, file),
            readScript: file => readFile(file, 'utf8').then(s => s.slice(0, 200_000)).catch(() => undefined),
        })
        const f = gate ? facts(ctx) : undefined
        if (gate && f && !f.grants.has(gate.key)) {
            if (!f.pending.some(c => c.gate?.key === gate.key))
                addCards([gateCard(gate)])
            publish(ctx, true)
            return { block: true, reason: gateReason(gate) }
        }
        if (event.toolName === 'write') {
            const raw = input?.path ?? input?.file_path
            if (typeof raw === 'string') {
                const file = path.resolve(ctx.cwd, raw)
                if (!existsSync(file))
                    created.add(file)
            }
        }
        return undefined
    })

    pi.on('input', async (event, ctx) => {
        if (event.source === 'extension' || event.text.trim().startsWith('/'))
            return { action: 'continue' }
        if (on) {
            // The user is here: their message goes first.
            const wasActive = !!active
            if (active) {
                active.cancelled = true
                active.stop?.()
            }
            if (retryTimer)
                clearTimeout(retryTimer)
            retryTimer = undefined
            const f = facts(ctx)
            const d = f.decisions.at(-1)
            // Setting the goal is not stepping in: a miss needs autopilot to have had its turn.
            if (!wasActive && !d)
                return { action: 'continue' }
            recordMiss(agentDir, {
                at: Date.now(),
                cwd: ctx.cwd,
                session,
                text: event.text,
                ...(f.reply ? { reply: clip(f.reply, 1200) } : {}),
                ...(d ? { decision: { next: d.next, message: d.message, reason: d.reason, rules: d.rules } } : {}),
                phase,
                ...(isAngry(event.text) ? { angry: true } : {}),
            })
        }
        return { action: 'continue' }
    })

    pi.on('session_shutdown', async () => {
        if (active) {
            active.cancelled = true
            active.stop?.()
        }
        if (retryTimer)
            clearTimeout(retryTimer)
        if (publishTimer)
            clearTimeout(publishTimer)
        watcher?.close()
        if (session)
            removePeer(agentDir, session)
        active = undefined
        current = undefined
    })

    // ------------------------------------------------------------ learning

    let learning = false
    async function learn(ctx: ExtensionContext) {
        if (learning)
            return ctx.ui.notify('已经在整理规则了', 'warning')
        const misses = readMisses(agentDir, lastLearned(agentDir))
        if (!misses.length)
            return ctx.ui.notify('上次整理之后还没有记录到你的干预', 'info')
        learning = true
        ctx.ui.notify(`Autopilot：用 ${misses.length} 条干预记录整理规则库…`, 'info')
        try {
            const rules = readRules(agentDir, ctx.cwd)
            const result = await runChild<{ rules: string, summary: string }>(pi, ctx, {
                title: 'Autopilot rules',
                task: learnTask(rules, misses, []),
                submit: SUBMIT_RULES,
                env: { [LEARNER_ENV]: '1' },
                exclude: 'edit,write',
                signal: { cancelled: false },
            })
            const proposal = result.submission
            if (!proposal?.rules?.trim())
                return ctx.ui.notify(`规则整理失败：${result.run.error ?? '没有交回规则'}`, 'error')
            const file = path.join(autopilotDir(agentDir), 'rules.proposed.md')
            mkdirSync(path.dirname(file), { recursive: true })
            writeFileSync(file, proposal.rules)
            addCards([{
                kind: 'autopilot-card',
                id: newId('card'),
                category: 'rules',
                title: '规则库更新',
                question: proposal.summary,
                options: [{ id: 'apply', label: '应用' }, { id: 'skip', label: '不用' }],
                recommended: 'apply',
                fallback: '保持现有规则',
                evidence: [file, path.join(autopilotDir(agentDir), 'rules.md')],
                rules: { text: proposal.rules, summary: proposal.summary },
                createdAt: Date.now(),
            }])
            publish(ctx, true)
        }
        finally {
            learning = false
        }
    }

    // ------------------------------------------------------------ commands

    pi.registerCommand(COMMAND, {
        description: 'Internal: turn autopilot on or off',
        handler: async (args, ctx) => {
            const value = args.trim()
            if (value !== 'on' && value !== 'off')
                return ctx.ui.notify(`用法：/${COMMAND} on|off`, 'error')
            current = ctx
            setOn(value === 'on', ctx)
        },
    })
    pi.registerCommand(ANSWER_COMMAND, {
        description: 'Internal: decide an autopilot card',
        handler: async (args, ctx) => {
            const space = args.indexOf(' ')
            const id = space < 0 ? args.trim() : args.slice(0, space)
            let value: AutopilotAnswer
            try {
                const parsed = JSON.parse(space < 0 ? '{}' : args.slice(space + 1))
                value = { ...(typeof parsed?.choice === 'string' ? { choice: parsed.choice } : {}), ...(typeof parsed?.text === 'string' ? { text: parsed.text } : {}) }
            }
            catch {
                return ctx.ui.notify('回答格式无效', 'error')
            }
            if (!value.choice && !value.text?.trim())
                return ctx.ui.notify('没有选项也没有文字', 'warning')
            if (!answerById(ctx, id, value, 'app')) {
                // Another session's card (the app's inbox lists the board).
                const owner = readPeers(agentDir).find(p => p.cards.some(c => c.id === id))
                if (!owner)
                    return ctx.ui.notify('这张卡片已经处理过了', 'warning')
                sendMail(agentDir, owner.session, { kind: 'answer', cardId: id, answer: value, at: Date.now() })
            }
        },
    })
    pi.registerCommand(LEARN_COMMAND, {
        description: 'Internal: propose rulebook changes from recorded interventions',
        handler: async (_args, ctx) => {
            void learn(ctx)
        },
    })

    /** The terminal inbox: every session's waiting cards, this one's first. */
    async function inbox(ctx: ExtensionCommandContext) {
        const own = facts(ctx).pending.map(card => ({ card, owner: undefined as AutopilotPeer | undefined }))
        const others = readPeers(agentDir).filter(p => p.session !== session).flatMap(p => p.cards.map(c => ({ card: c as AutopilotCard, owner: p })))
        const all = [...own, ...others]
        if (!all.length)
            return ctx.ui.notify('没有等你决定的卡片', 'info')
        for (const { card, owner } of all) {
            const where = owner ? `${path.basename(owner.cwd)}${owner.topic ? ` · ${owner.topic}` : ''}` : '这个会话'
            const options = [...card.options.map(o => `${o.label}${o.id === card.recommended ? '（推荐）' : ''}${o.detail ? ` — ${o.detail}` : ''}`), '自己写…', '跳过']
            const full = own.find(o => o.card.id === card.id)?.card
            const body = [`${where} · ${card.category}`, ...(full?.evidence?.length ? [`看这些：${full.evidence.join('  ')}`] : []), ...(full?.fallback ? [`没人回答时：${full.fallback}`] : [])]
            const index = await serialized(() => choose(ctx, { title: card.title, body, question: card.question, options }))
            if (index === undefined)
                return
            if (index === options.length - 1)
                continue
            let value: AutopilotAnswer
            if (index === options.length - 2) {
                const text = (await ctx.ui.input(card.title, '你的决定'))?.trim()
                if (!text)
                    continue
                value = { text }
            }
            else {
                value = { choice: card.options[index].id }
            }
            if (owner)
                sendMail(agentDir, owner.session, { kind: 'answer', cardId: card.id, answer: value, at: Date.now() })
            else
                answerById(ctx, card.id, value, 'terminal')
        }
    }

    pi.registerCommand('autopilot', {
        description: 'Autopilot: a supervisor answers the agent for you. /autopilot [on|off|inbox|learn]',
        handler: async (args, ctx) => {
            current = ctx
            const value = args.trim()
            if (value === 'inbox')
                return inbox(ctx)
            if (value === 'learn')
                return void learn(ctx)
            setOn(value === 'on' ? true : value === 'off' ? false : !on, ctx)
            ctx.ui.notify(on ? 'Autopilot 开了：每轮结束后由监督者替你回复，只有需要你拍板的事才会进 /inbox' : 'Autopilot 关了', 'info')
        },
    })
    pi.registerCommand('inbox', {
        description: 'Autopilot: decide the cards waiting for you, in every session',
        handler: async (_args, ctx) => inbox(ctx),
    })

    // ------------------------------------------------------------ terminal rendering

    pi.registerEntryRenderer<AutopilotDecision>(AUTOPILOT_TYPES.decision, (entry, options, theme) => {
        const d = entry.data
        if (!d)
            return undefined
        const verb = d.status !== 'done' ? `failed: ${d.error ?? ''}` : d.next === 'continue' ? 'continue' : d.next === 'wait' ? 'waiting for you' : 'done'
        const head = `${theme.fg(d.status === 'done' ? 'accent' : 'error', '⏺')} ${theme.bold('Autopilot')}(${verb}${d.rules.length ? ` · ${d.rules.join(' ')}` : ''})`
        const lines = [d.reason, ...(d.valve ? [theme.fg('warning', d.valve)] : []), ...(options.expanded ? d.commands.map(c => theme.fg('dim', `$ ${oneLine(c.command, 100)} → ${c.exitCode ?? '…'}`)) : [])].filter(Boolean)
        const box = new Container()
        box.addChild(new Text(head, 0, 0))
        if (lines.length)
            box.addChild(hang(theme, lines))
        return box
    })
    pi.registerEntryRenderer<AutopilotCard>(AUTOPILOT_TYPES.card, (entry, _options, theme) => {
        const c = entry.data
        if (!c)
            return undefined
        const box = new Container()
        box.addChild(new Text(`${theme.fg('warning', '◆')} ${theme.bold(c.title)} ${theme.fg('dim', `· ${c.category} · /inbox`)}`, 0, 0))
        box.addChild(hang(theme, [c.question, ...c.options.map((o, i) => `${i + 1}. ${o.label}${o.id === c.recommended ? theme.fg('accent', ' ★') : ''}${o.detail ? theme.fg('dim', ` — ${o.detail}`) : ''}`), ...(c.evidence?.length ? [theme.fg('dim', c.evidence.join('  '))] : [])]))
        return box
    })
    pi.registerEntryRenderer<AutopilotAnswerEntry>(AUTOPILOT_TYPES.answer, (entry, _options, theme) => {
        const a = entry.data
        if (!a || !current)
            return undefined
        const card = facts(current).cards.find(c => c.id === a.cardId)
        const label = card?.options.find(o => o.id === a.choice)?.label ?? a.choice ?? ''
        return new Text(`${theme.fg('success', '✓')} ${card?.title ?? a.cardId}: ${[label, a.text].filter(Boolean).join(' · ')}`, 0, 0)
    })
    pi.registerMessageRenderer<AutopilotMessageDetails>(AUTOPILOT_TYPES.message, (message, _options, theme) => {
        const from = message.details?.from
        const who = from === 'user' ? 'Your decision' : from === 'peer' ? 'Another session' : from === 'retry' ? 'Autopilot retry' : 'Autopilot'
        const body = typeof message.content === 'string' ? message.content : message.content.map(c => c.type === 'text' ? c.text : '').join('')
        const box = new Container()
        box.addChild(new Text(`${theme.fg('accent', '❯')} ${theme.bold(who)}`, 0, 0))
        box.addChild(hang(theme, body.split('\n')))
        return box
    })
}

export default function (pi: ExtensionAPI) {
    if (process.env[SUPERVISOR_ENV])
        return supervisor(pi)
    if (process.env[LEARNER_ENV])
        return learner(pi)
    // An ordinary subagent's or reviewer's pi: autopilot belongs to the session the user talks to.
    if (process.env[SUBAGENT_ENV])
        return
    host(pi)
}
