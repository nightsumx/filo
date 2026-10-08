// The parts of autopilot that need no pi process: which calls the hard rules hold for the user, what
// the supervisor is told, how its submission becomes a decision and cards, the safety valves that
// override it, the board and mailboxes shared by sessions, and the record of what the user still had
// to say (the material for the next rulebook).
import type { AutopilotAnswerEntry, AutopilotCard, AutopilotCategory, AutopilotConfig, AutopilotDecision, AutopilotGate, AutopilotMail, AutopilotMiss, AutopilotOption, AutopilotPeer, ReviewEvidence } from '../protocol'
import type { Changes } from './review'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clip } from './child'
import { evidenceOf } from './review'

export const AUTOPILOT_TYPES = {
    mode: 'pi-kit-autopilot-mode',
    decision: 'pi-kit-autopilot',
    card: 'pi-kit-autopilot-card',
    answer: 'pi-kit-autopilot-answer',
    message: 'pi-kit-autopilot-message',
} as const

export const AUTOPILOT_DIR = 'autopilot'

/** Sizes of what the supervisor is told. */
const MESSAGE_CLIP = 2500
const LOG_BUDGET = 24_000
const REPLY_CLIP = 8000
const COMMANDS_BUDGET = 10_000
const COMMAND_OUTPUT_CLIP = 600
export const SUPERVISOR_DIFF_BUDGET = 40_000
const PEER_CLIP = 600

// ---------------------------------------------------------------- hard rules

/** Substrings that mean a paid generation API, matched case-insensitively in a command or the script it runs. */
export const DEFAULT_PAID = [
    'fal.run',
    'fal.ai',
    '@fal-ai/',
    'fal_key',
    'pixellab',
    'elevenlabs',
    'api.minimax',
    'minimaxi.com',
    'minimax_api',
    'api.meshy',
    'replicate.com',
    'replicate_api',
    'seedance',
    'images/generations',
    'api.runwayml',
    'api.stability.ai',
    'suno.com',
]

export type FileState = 'tmp' | 'created' | 'ignored' | 'clean' | 'dirty' | 'untracked' | 'outside' | 'missing'

export interface GateContext {
    cwd: string
    config: AutopilotConfig
    /** Files this session's write calls created. */
    created: ReadonlySet<string>
    /** Whether deleting this path loses something git or this session cannot bring back. */
    fileState: (file: string) => Promise<FileState>
    /** A local script's source, to look for paid APIs inside it. */
    readScript: (file: string) => Promise<string | undefined>
}

const TMP_ROOTS = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders'].map(p => path.resolve(p))
export const inTmp = (file: string) => TMP_ROOTS.some(root => file === root || file.startsWith(`${root}${path.sep}`))

const expandHome = (p: string) => p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
const unquote = (w: string) => w.replace(/^['"]|['"]$/g, '')

/** Commands split at `&&`, `||`, `;`, `|`, `&` and newlines, as words. Quotes are only trimmed. */
function segments(command: string): string[][] {
    return command.split(/\|\||&&|[|;&\n]/).map(s => s.trim().split(/\s+/).filter(Boolean).map(unquote)).filter(w => w.length > 0)
}

/** Program and arguments, past leading `VAR=value` assignments and wrappers that run the rest. */
function programOf(words: string[]): { program: string, args: string[], sudo: boolean } {
    let i = 0
    let sudo = false
    while (i < words.length) {
        const w = words[i]
        if (/^\w+=/.test(w)) {
            i++
        }
        else if (w === 'sudo' || w === 'doas') {
            sudo = true
            i++
            while (i < words.length && words[i].startsWith('-'))
                i++
        }
        else if (w === 'env' || w === 'command' || w === 'exec' || w === 'nohup' || w === 'time') {
            if (w === 'env' && i === words.length - 1)
                break
            i++
        }
        else {
            break
        }
    }
    const program = path.basename(words[i] ?? '')
    return { program, args: words.slice(i + 1), sudo }
}

/** git's subcommand and its arguments, past `-C dir`, `-c key=value` and other global flags. */
function gitCommand(args: string[]): { sub: string, rest: string[] } {
    let i = 0
    while (i < args.length && args[i].startsWith('-')) {
        i += args[i] === '-C' || args[i] === '-c' || args[i] === '--git-dir' || args[i] === '--work-tree' ? 2 : 1
    }
    return { sub: args[i] ?? '', rest: args.slice(i + 1) }
}

const hasFlag = (args: string[], ...flags: string[]) => args.some(a => flags.includes(a) || flags.some(f => f.length === 2 && f[0] === '-' && /^-[a-zA-Z]+$/.test(a) && a.includes(f[1])))

function gitGate(args: string[]): Omit<AutopilotGate, 'tool' | 'summary'> | undefined {
    const { sub, rest } = gitCommand(args)
    if (rest.includes('--no-verify') || (sub === 'commit' && hasFlag(rest, '-n')))
        return { key: 'git --no-verify', why: '跳过 git hook' }
    switch (sub) {
        case 'push':
            if (rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('+')))
                return { key: 'git push --force', why: '强推会改写远端历史' }
            if (rest.includes('--delete') || rest.includes('-d') || rest.some(a => a.startsWith(':')))
                return { key: 'git push --delete', why: '删除远端分支或标签' }
            return { key: 'git push', why: '推送到远端' }
        case 'reset':
            return rest.includes('--hard') ? { key: 'git reset --hard', why: '丢弃未提交的改动（可能是别的会话的）' } : undefined
        case 'clean':
            return hasFlag(rest, '-f', '--force') ? { key: 'git clean', why: '删除未跟踪文件，无法恢复' } : undefined
        case 'stash':
            return rest[0] === 'drop' || rest[0] === 'clear' ? { key: 'git stash drop', why: '丢弃暂存的改动' } : undefined
        case 'branch':
            return rest.includes('-D') || (hasFlag(rest, '-d', '--delete') && hasFlag(rest, '-f', '--force')) ? { key: 'git branch -D', why: '强删分支' } : undefined
        case 'checkout':
            return rest.includes('--') || rest.includes('.') || rest.includes('-f') || rest.includes('--force') ? { key: 'git checkout --', why: '丢弃工作区改动（可能是别的会话的）' } : undefined
        case 'restore':
            return rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W') ? undefined : { key: 'git restore', why: '丢弃工作区改动（可能是别的会话的）' }
        case 'filter-branch':
        case 'filter-repo':
            return { key: 'git rewrite', why: '改写历史' }
        default:
            return undefined
    }
}

const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'strings', 'xxd', 'od', 'grep', 'rg'])
const RUNNERS = new Set(['node', 'bun', 'deno', 'tsx', 'ts-node', 'python', 'python3', 'ruby'])

function fixedGate(program: string, args: string[], sudo: boolean): Omit<AutopilotGate, 'tool' | 'summary'> | undefined {
    if (sudo)
        return { key: 'sudo', why: '需要管理员权限' }
    if (program === 'git')
        return gitGate(args)
    if (PUBLISHERS.has(program) && args[0] === 'publish')
        return { key: 'publish', why: '发布包到公共仓库' }
    if (program === 'wrangler' || (program === 'npx' && args[0] === 'wrangler') || (program === 'bunx' && args[0] === 'wrangler')) {
        const a = program === 'wrangler' ? args : args.slice(1)
        const [sub, second] = a
        if (sub === 'deploy' || sub === 'publish' || sub === 'delete' || sub === 'rollback')
            return { key: `wrangler ${sub}`, why: '改动线上 Cloudflare 服务' }
        if ((sub === 'pages' && (second === 'deploy' || second === 'publish')) || (sub === 'versions' && second === 'deploy'))
            return { key: `wrangler ${sub} ${second}`, why: '改动线上 Cloudflare 服务' }
        if (sub === 'secret' && second !== 'list')
            return { key: 'wrangler secret', why: '改动线上密钥' }
        if ((sub === 'd1' || sub === 'kv' || sub === 'r2' || sub === 'queues') && a.includes('--remote') && !a.includes('--command=SELECT'))
            return { key: `wrangler ${sub} --remote`, why: '改动线上数据' }
        if ((sub === 'kv' || sub === 'r2') && a.includes('delete'))
            return { key: `wrangler ${sub} delete`, why: '删除线上数据' }
        return undefined
    }
    if (program === 'gh') {
        const [noun, verb] = args
        const risky: Record<string, string[]> = {
            repo: ['create', 'edit', 'delete', 'rename', 'archive', 'transfer'],
            release: ['create', 'delete', 'edit', 'upload'],
            pr: ['merge'],
            secret: ['set', 'delete'],
            api: [],
        }
        if (noun === 'api' && hasFlag(args, '-X', '--method') && !args.includes('GET'))
            return { key: 'gh api write', why: '改动 GitHub 上的东西' }
        if (risky[noun]?.includes(verb))
            return { key: `gh ${noun} ${verb}`, why: noun === 'repo' ? '改动 GitHub 仓库（可见性、名字、删除）' : '改动 GitHub 上的东西' }
        return undefined
    }
    if ((program === 'vercel' && (args.includes('--prod') || args[0] === 'deploy')) || (program === 'netlify' && args[0] === 'deploy') || ((program === 'firebase' || program === 'fly' || program === 'flyctl') && args[0] === 'deploy'))
        return { key: `${program} deploy`, why: '部署到线上' }
    if (program === 'brew' && ['upgrade', 'uninstall', 'remove', 'rm', 'reinstall', 'untap'].includes(args[0] ?? ''))
        return { key: `brew ${args[0]}`, why: '改动系统里装的软件' }
    if ((program === 'pip' || program === 'pip3') && args[0] === 'uninstall')
        return { key: 'pip uninstall', why: '改动系统里装的软件' }
    if (program === 'printenv' || (program === 'env' && !args.length))
        return { key: 'print env', why: '会把密钥打印进对话' }
    if (READERS.has(program) && args.some(a => !a.startsWith('-') && path.basename(a).startsWith('.env') && !a.endsWith('.example') && !a.endsWith('.sample')))
        return { key: 'print secrets', why: '会把 .env 里的密钥打印进对话' }
    return undefined
}

function paidPattern(text: string, patterns: readonly string[]): string | undefined {
    const lower = text.toLowerCase()
    return patterns.find(p => lower.includes(p.toLowerCase()))
}

/** The call the hard rules hold for the user, if any. */
export async function gateOf(tool: string, input: any, g: GateContext): Promise<AutopilotGate | undefined> {
    if (tool === 'write' || tool === 'edit') {
        const raw = input?.path ?? input?.file_path
        if (typeof raw !== 'string')
            return undefined
        const file = path.resolve(g.cwd, expandHome(raw))
        if (path.basename(file).startsWith('.env') && !file.endsWith('.example'))
            return { key: `write ${file}`, tool, summary: `${tool} ${raw}`, why: '改动密钥文件' }
        const prefix = (g.config.protected ?? []).map(p => path.resolve(expandHome(p))).find(p => file === p || file.startsWith(`${p}${path.sep}`))
        if (prefix)
            return { key: `protected ${prefix}`, tool, summary: `${tool} ${raw}`, why: '用户保护的路径' }
        return undefined
    }
    if (tool !== 'bash')
        return undefined
    const command = String(input?.command ?? '')
    const summary = clip(command.replace(/\s+/g, ' ').trim(), 300)
    const patterns = [...DEFAULT_PAID, ...(g.config.paid ?? [])]
    const paid = paidPattern(command, patterns)
    if (paid)
        return { key: `paid ${paid}`, tool, summary, why: `调用付费接口（${paid}）` }
    let cwd = g.cwd
    for (const words of segments(command)) {
        const { program, args, sudo } = programOf(words)
        if (program === 'cd') {
            if (args[0] && !args[0].startsWith('-'))
                cwd = path.resolve(cwd, expandHome(args[0]))
            continue
        }
        const fixed = fixedGate(program, args, sudo)
        if (fixed)
            return { ...fixed, tool, summary }
        if (program === 'rm' || program === 'rmdir' || program === 'unlink' || program === 'trash' || (program === 'find' && args.includes('-delete'))) {
            const targets = program === 'find' ? [args.find(a => !a.startsWith('-')) ?? '.'] : args.filter(a => !a.startsWith('-'))
            for (const target of targets) {
                if (target.includes('*') || target.includes('?')) {
                    const base = path.resolve(cwd, expandHome(target.slice(0, target.search(/[*?]/))))
                    if (!inTmp(base))
                        return { key: `rm ${path.resolve(cwd, expandHome(target))}`, tool, summary, why: '用通配符删除，范围不确定' }
                    continue
                }
                const file = path.resolve(cwd, expandHome(target))
                if (inTmp(file) || g.created.has(file))
                    continue
                const state = await g.fileState(file)
                if (state === 'dirty' || state === 'untracked' || state === 'outside')
                    return { key: `rm ${file}`, tool, summary, why: state === 'outside' ? '删除项目外的文件' : '删除的文件有未提交的内容，删了就找不回来' }
            }
        }
        if (RUNNERS.has(program) || (program === 'npx' && args[0] === 'tsx')) {
            const a = program === 'npx' ? args.slice(1) : args
            const script = a.find(x => !x.startsWith('-') && x !== 'run' && /\.[cm]?[jt]sx?$|\.py$|\.rb$/.test(x))
            if (script) {
                const source = await g.readScript(path.resolve(cwd, expandHome(script)))
                const inside = source ? paidPattern(source, patterns) : undefined
                if (inside)
                    return { key: `paid ${inside}`, tool, summary, why: `脚本 ${script} 调用付费接口（${inside}）` }
            }
        }
    }
    return undefined
}

/** Calls the supervisor itself may not make: the hard rules plus anything that changes the repository. */
export function supervisorBlocks(command: string): string | undefined {
    for (const words of segments(command)) {
        const { program, args, sudo } = programOf(words)
        if (fixedGate(program, args, sudo))
            return 'the user\'s hard rules hold this command'
        if (program === 'git') {
            const { sub } = gitCommand(args)
            if (['add', 'commit', 'checkout', 'switch', 'reset', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'rm', 'mv', 'clean', 'push', 'pull', 'tag', 'am', 'apply'].includes(sub))
                return 'the supervisor does not change the repository'
        }
        if (program === 'rm' || program === 'rmdir' || program === 'mv') {
            const targets = args.filter(a => !a.startsWith('-'))
            if (targets.some(t => !inTmp(path.resolve(expandHome(t)))))
                return 'the supervisor only deletes or moves files in the temp directory'
        }
    }
    return undefined
}

// ---------------------------------------------------------------- the session branch

const textOf = (content: unknown): string => typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('\n') : ''

function messageOf(entry: any): any {
    if (entry?.type === 'message')
        return entry.message
    if (entry?.type === 'custom_message')
        return { role: 'custom', customType: entry.customType, content: entry.content, details: entry.details }
    return undefined
}

export interface LogLine {
    who: 'user' | 'supervisor' | 'relay' | 'agent'
    text: string
}

export interface LastRun {
    /** bash commands with their results, oldest first. */
    commands: ReviewEvidence[]
    /** Files edit/write touched in the run. */
    files: string[]
    tools: number
    stopReason?: string
    error?: string
}

export interface AutopilotFacts {
    on: boolean
    log: LogLine[]
    /** The agent's final reply of the last run, whole (clipped). */
    reply: string
    run: LastRun
    /** Files the thread's edit/write calls touched. */
    files: string[]
    decisions: AutopilotDecision[]
    cards: AutopilotCard[]
    answers: AutopilotAnswerEntry[]
    pending: AutopilotCard[]
    /** Gate keys the user allowed. */
    grants: Set<string>
    /** API errors in a row at the end of the branch. */
    errors: number
}

const editedPath = (block: any, cwd: string) => {
    if (block?.type !== 'toolCall' || (block.name !== 'edit' && block.name !== 'write'))
        return undefined
    const file = block.arguments?.path ?? block.arguments?.file_path
    return typeof file === 'string' && file ? path.resolve(cwd, file) : undefined
}

/** Everything autopilot reads from the branch (session entries root to leaf). */
export function autopilotFacts(entries: readonly any[], cwd: string): AutopilotFacts {
    const log: LogLine[] = []
    const files = new Set<string>()
    const decisions: AutopilotDecision[] = []
    const cards: AutopilotCard[] = []
    const answers: AutopilotAnswerEntry[] = []
    let on = false
    let run: LastRun = { commands: [], files: [], tools: 0 }
    let runFiles = new Set<string>()
    let calls = new Map<string, string>()
    let reply = ''
    let errors = 0
    const startRun = () => {
        run = { commands: [], files: [], tools: 0 }
        runFiles = new Set()
        calls = new Map()
        reply = ''
    }
    for (const entry of entries) {
        if (entry?.type === 'custom') {
            if (entry.customType === AUTOPILOT_TYPES.mode)
                on = entry.data?.on === true
            else if (entry.customType === AUTOPILOT_TYPES.decision && entry.data?.kind === 'autopilot')
                decisions.push(entry.data)
            else if (entry.customType === AUTOPILOT_TYPES.card && entry.data?.kind === 'autopilot-card')
                cards.push(entry.data)
            else if (entry.customType === AUTOPILOT_TYPES.answer && typeof entry.data?.cardId === 'string')
                answers.push(entry.data)
            continue
        }
        const message = messageOf(entry)
        if (!message)
            continue
        if (message.role === 'user') {
            log.push({ who: 'user', text: textOf(message.content) })
            startRun()
        }
        else if (message.role === 'custom' && message.customType === AUTOPILOT_TYPES.message) {
            const from = message.details?.from
            log.push({ who: from === 'supervisor' || from === 'retry' ? 'supervisor' : 'relay', text: textOf(message.content) })
            startRun()
        }
        else if (message.role === 'custom' && message.content) {
            log.push({ who: 'relay', text: textOf(message.content) })
            startRun()
        }
        else if (message.role === 'assistant') {
            const text = textOf(message.content).trim()
            if (text)
                reply = text
            run.stopReason = message.stopReason
            run.error = message.stopReason === 'error' ? message.errorMessage : undefined
            errors = message.stopReason === 'error' ? errors + 1 : 0
            for (const block of message.content ?? []) {
                if (block?.type !== 'toolCall')
                    continue
                run.tools++
                if (block.name === 'bash' && typeof block.arguments?.command === 'string')
                    calls.set(block.id, block.arguments.command)
                const file = editedPath(block, cwd)
                if (file) {
                    files.add(file)
                    runFiles.add(file)
                }
            }
            if (text && log.at(-1)?.who === 'agent')
                log[log.length - 1] = { who: 'agent', text }
            else if (text)
                log.push({ who: 'agent', text })
        }
        else if (message.role === 'toolResult') {
            const command = calls.get(message.toolCallId)
            if (command !== undefined)
                run.commands.push(evidenceOf(command, message, message.isError === true))
        }
    }
    run.files = [...runFiles]
    const answered = new Set(answers.map(a => a.cardId))
    const grants = new Set<string>()
    for (const a of answers) {
        const card = cards.find(c => c.id === a.cardId)
        if (card?.gate && a.choice === 'allow')
            grants.add(card.gate.key)
    }
    return {
        on,
        log: fitLog(log),
        reply: clip(reply, REPLY_CLIP),
        run,
        files: [...files],
        decisions,
        cards,
        answers,
        pending: cards.filter(c => !answered.has(c.id)),
        grants,
        errors,
    }
}

/** The first line and as many of the latest as fit, each clipped. */
function fitLog(lines: LogLine[]): LogLine[] {
    const clipped = lines.map(l => ({ ...l, text: clip(l.text.trim(), MESSAGE_CLIP) })).filter(l => l.text)
    let used = 0
    const kept: LogLine[] = []
    for (let i = clipped.length - 1; i > 0 && used + clipped[i].text.length <= LOG_BUDGET; i--) {
        kept.unshift(clipped[i])
        used += clipped[i].text.length
    }
    const dropped = clipped.length - 1 - kept.length
    if (!clipped.length)
        return []
    return [clipped[0], ...(dropped > 0 ? [{ who: 'relay' as const, text: `(${dropped} earlier messages omitted)` }] : []), ...kept]
}

// ---------------------------------------------------------------- the supervisor's task

export interface GitFacts {
    branch?: string
    /** `git status --short` lines. */
    status: string[]
    /** Minutes since the last commit. */
    sinceCommit?: number
    /** Commits not pushed. */
    ahead?: number
}

export interface SupervisorInput {
    facts: AutopilotFacts
    changes: Changes
    git?: GitFacts
    peers: AutopilotPeer[]
    rules: string
    session: string
    cwd: string
}

const section = (title: string, body: string) => `## ${title}\n\n${body.trim()}\n`
const quote = (text: string) => text.split('\n').map(l => `> ${l}`).join('\n')
const WHO: Record<LogLine['who'], string> = { user: 'USER', supervisor: 'SUPERVISOR (you, earlier, in the user\'s place)', relay: 'RELAYED', agent: 'AGENT' }

/** Rules every user gets; the rulebook adds the user's own. */
export const BASE_RULES = `- Only the user decides taste (how it looks and sounds), product direction, spending, releases and deletions. Put those on cards; never decide them in a message.
- Everything else inside the goal the user set, you decide. "Should I continue?" inside an approved plan gets "continue" and, when the agent listed options, the one it recommends.
- "Done" needs evidence from the real path: the app, page or command a user would run, not only unit tests or a clean build. When the evidence is missing, ask for it.
- What the agent itself lists as missing, simplified, differing from the reference or left for later is the next task, unless it is a card.
- After a bug fix, have the same kind of bug looked for everywhere else.
- Rejected twice by the user in the same way: stop tuning; ask for 3 to 6 different candidates side by side and put the choice on a card.
- When the user's last message was a question or asked for discussion, the agent answers it and changes nothing.`

export function supervisorTask(input: SupervisorInput): string {
    const { facts, changes, git, peers } = input
    const parts: string[] = [
        'You supervise a coding agent in the user\'s place. The user has stepped away and wants the work driven to the goal they set, the way they would drive it. You read what happened, check it, and decide the one next thing the user would say. You did not do the work and have not seen the agent\'s reasoning; its claims are unverified until you check them.\n',
        section('The user\'s rulebook', `${BASE_RULES}\n\n${input.rules.trim() || '(The user has no rulebook yet.)'}`),
        section('The conversation so far', facts.log.length ? facts.log.map(l => `**${WHO[l.who]}**\n${quote(l.text)}`).join('\n\n') : '(empty)'),
        section('The agent\'s last reply', facts.reply ? quote(facts.reply) : '(no text: it stopped without replying)'),
    ]
    const run = facts.run
    let runBody = `${run.tools} tool calls. Stop reason: ${run.stopReason ?? 'unknown'}${run.error ? ` (${run.error})` : ''}.\n`
    if (run.files.length)
        runBody += `\nFiles edited in this run:\n${run.files.map(f => `- ${path.relative(input.cwd, f) || f}`).join('\n')}\n`
    if (run.commands.length) {
        let used = 0
        const shownCommands: string[] = []
        for (const c of [...run.commands].reverse()) {
            const line = `- \`${clip(c.command.replace(/\s+/g, ' '), 300)}\` → ${c.exitCode ?? 'did not finish'}${c.output ? `\n  ${clip(c.output, COMMAND_OUTPUT_CLIP).split('\n').join('\n  ')}` : ''}`
            if (used + line.length > COMMANDS_BUDGET)
                break
            shownCommands.unshift(line)
            used += line.length
        }
        runBody += `\nCommands it ran (latest ${shownCommands.length} of ${run.commands.length}) and exit codes:\n${shownCommands.join('\n')}\n`
    }
    parts.push(section('What the agent did in its last run', runBody))
    let changeBody = changes.files.length ? `${changes.scope === 'thread' ? 'Files this thread edited' : 'Every uncommitted change'} (${changes.files.length}):\n${changes.files.map(f => `- ${f}`).join('\n')}\n` : 'No file changes.\n'
    if (changes.diff)
        changeBody += `\n\`\`\`diff\n${changes.diff}\n\`\`\`\n`
    if (changes.unshown.length)
        changeBody += `\nNot shown above (run git diff yourself when it matters): ${changes.unshown.join(', ')}\n`
    if (git)
        changeBody += `\nGit: branch ${git.branch ?? '?'}, ${git.status.length} uncommitted paths${git.sinceCommit !== undefined ? `, last commit ${git.sinceCommit} min ago` : ''}${git.ahead ? `, ${git.ahead} commits not pushed` : ''}.\n`
    parts.push(section('The working tree', changeBody))
    if (facts.cards.length) {
        const answered = new Map(facts.answers.map(a => [a.cardId, a]))
        const lines = facts.cards.slice(-12).map((c) => {
            const a = answered.get(c.id)
            const choice = a ? `answered: ${c.options.find(o => o.id === a.choice)?.label ?? a.choice ?? ''}${a.text ? ` "${a.text}"` : ''}` : 'WAITING for the user'
            return `- [${c.category}] ${c.title}: ${c.question} (${choice})`
        })
        parts.push(section('Cards (decisions only the user makes)', `${lines.join('\n')}\n\nDo not add a card that repeats one still waiting. Work that does not depend on a waiting card goes on.`))
    }
    if (facts.grants.size)
        parts.push(section('Calls the user allowed in this session', [...facts.grants].map(k => `- ${k}`).join('\n')))
    const recent = facts.decisions.slice(-5)
    if (recent.length)
        parts.push(section('Your recent decisions', recent.map(d => `- ${d.next}${d.rules.length ? ` [${d.rules.join(' ')}]` : ''}: ${d.reason}${d.valve ? ` (overridden: ${d.valve})` : ''}`).join('\n')))
    if (peers.length) {
        parts.push(section('Other sessions in the same project', `${peers.map(p => `- session \`${p.session}\` (${p.state}${p.topic ? `, ${p.topic}` : ''}), files: ${p.files.slice(0, 12).map(f => path.relative(p.root, f)).join(', ') || 'none yet'}${p.last ? `\n  latest reply: ${clip(p.last.replace(/\s+/g, ' '), PEER_CLIP)}` : ''}`).join('\n')}\n\nThey share the working directory. Steer this agent away from files and topics another session owns, have it commit only its own files, and never let it wait for another session when other work exists. To tell another session something (it already did this, it is about to break your files), add a \`peers\` note.`))
    }
    parts.push(section('How to decide', [
        '- First check: run what proves or disproves the agent\'s claims (tests, type check, build, a headless run or screenshot, reading the code). You may not change the project: no edits, commits or installs; scratch files go in the temp directory. Some commands are blocked for you.',
        '- Then pick the first that applies: a claim failed your check or was never verified → continue with what to fix or verify. The user\'s last message asked a question or for discussion → the agent should answer without changing anything. The agent asked permission for work inside the goal → continue. The agent listed what is missing, differs or was left out → continue with doing it. Same kind of bug may exist elsewhere → have it checked. Verified work not committed → have it committed (its own files, by topic). Only user decisions remain → wait, with cards. The goal is met and checked → done.',
        '- `message` is what the user would type: short, direct, in the user\'s language and manner as the conversation and rulebook show. It names what to do, not a lecture. Put your evidence in it when the agent must see it (a failing command and its output).',
        '- Cards are for what only the user decides. Give 2 to 6 options with ids, your recommendation, what happens meanwhile (`fallback`, always the safe choice: change nothing, spend nothing, publish nothing), and evidence files (screenshots, contact sheets) when there is something to look at. With cards you can still continue on everything that does not depend on them.',
        '- `rules`: the rulebook ids your decision rests on. `topic`: what this thread works on, in a few words.',
        '- Never approve, or tell the agent to run, anything the hard rules hold: pushing, deploying, publishing, paid generation, deleting what it did not create, sudo, printing secrets. Those reach the user as cards on their own.',
        '- Finish by calling submit_decision once.',
    ].join('\n')))
    parts.push(`\n(This session: ${input.session})`)
    return parts.join('\n')
}

// ---------------------------------------------------------------- the decision

export interface Submission {
    next: 'continue' | 'wait' | 'done'
    message?: string
    reason: string
    rules?: string[]
    topic?: string
    cards?: {
        category?: string
        title: string
        question: string
        options: { id?: string, label: string, detail?: string }[]
        recommended?: string
        fallback?: string
        evidence?: string[]
    }[]
    peers?: { session: string, text: string }[]
}

const CATEGORIES: readonly AutopilotCategory[] = ['taste', 'direction', 'money', 'release', 'delete', 'naming', 'theory', 'gate', 'rules', 'other']

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Cards from the submission, with option ids filled in (A, B, …) and the recommendation resolved to one. */
export function cardsOf(submission: Submission, now = Date.now()): AutopilotCard[] {
    return (submission.cards ?? []).filter(c => c?.title && c.question).map((c) => {
        const options: AutopilotOption[] = (c.options ?? []).filter(o => o?.label).map((o, i) => ({
            id: o.id?.trim() || String.fromCharCode(65 + i),
            label: o.label,
            ...(o.detail ? { detail: o.detail } : {}),
        }))
        const rec = c.recommended?.trim()
        const recommended = rec ? (options.find(o => o.id === rec) ?? options.find(o => o.label === rec))?.id : undefined
        const category = CATEGORIES.includes(c.category as AutopilotCategory) ? c.category as AutopilotCategory : 'other'
        return {
            kind: 'autopilot-card',
            id: newId('card'),
            category,
            title: c.title,
            question: c.question,
            options,
            ...(recommended ? { recommended } : {}),
            ...(c.fallback ? { fallback: c.fallback } : {}),
            ...(c.evidence?.length ? { evidence: c.evidence } : {}),
            createdAt: now,
        }
    })
}

export interface ValveResult {
    valve: string
    card: AutopilotCard
}

/**
 * Safety valves: the same rule fired three times in a row without the user, or the agent did nothing
 * in its last two runs. Either way the supervisor is not getting anywhere, so the user looks.
 */
export function valveOf(submission: Submission, workTools: number, history: readonly AutopilotDecision[]): ValveResult | undefined {
    if (submission.next !== 'continue')
        return undefined
    const previous = history.filter(d => d.status === 'done' && d.next === 'continue').slice(-2)
    let valve: string | undefined
    const rules = submission.rules ?? []
    if (previous.length === 2 && rules.length) {
        const repeated = rules.filter(r => previous.every(d => d.rules.includes(r)))
        if (repeated.length)
            valve = `${repeated.join(' ')} 连续三次命中，同一个问题没改过来`
    }
    if (!valve && previous.length === 2 && workTools === 0 && previous.at(-1)!.workTools === 0)
        valve = '连续两轮 AI 什么都没做'
    if (!valve)
        return undefined
    return {
        valve,
        card: {
            kind: 'autopilot-card',
            id: newId('card'),
            category: 'direction',
            title: '自动驾驶停下了',
            question: `${valve}。监督者本来要说：「${clip(submission.message ?? '', 400)}」`,
            options: [{ id: 'go', label: '照监督者的话继续' }, { id: 'stop', label: '先停，我来看' }],
            fallback: '保持暂停',
            held: submission.message,
            createdAt: Date.now(),
        },
    }
}

/** What the agent is told when the user decides a card. */
export function answerText(card: AutopilotCard, answer: { choice?: string, text?: string }): string {
    const label = card.options.find(o => o.id === answer.choice)?.label ?? answer.choice ?? ''
    if (card.gate) {
        return answer.choice === 'allow'
            ? `用户批准了：${card.gate.summary}。可以执行了${answer.text ? `。${answer.text}` : ''}`
            : `用户不允许：${card.gate.summary}。别做这一步${answer.text ? `：${answer.text}` : ''}，继续别的。`
    }
    return `用户对「${card.title}」的决定：${[label, answer.text].filter(Boolean).join('。')}`
}

/** The card for a call the hard rules held. */
export function gateCard(gate: AutopilotGate): AutopilotCard {
    return {
        kind: 'autopilot-card',
        id: newId('card'),
        category: 'gate',
        title: `允许 ${gate.key}？`,
        question: `${gate.why}：\`${gate.summary}\``,
        options: [{ id: 'allow', label: '允许（本会话内同类都允许）' }, { id: 'deny', label: '不允许' }],
        fallback: '不执行，AI 先做别的',
        gate,
        createdAt: Date.now(),
    }
}

export const gateReason = (gate: AutopilotGate) =>
    `Held for the user (${gate.why}). The user is away; this is now a card in their inbox. Do not try another way around it. Carry on with work that does not depend on it, and mention it in your final reply. You will be told when the user decides.`

/** Added to the agent's system prompt while autopilot is on. */
export const WORKER_INSTRUCTIONS = `Autopilot is on: the user stepped away, and a supervisor reads your final reply and answers in the user's place.
- Do not stop to ask permission for work inside the goal. Keep going until it is done and verified on the real path.
- Begin your final reply with one status line: done or not, commit hash or "uncommitted", where the result is (path, URL, command), verified or not. Write it in the user's language.
- List what only the user can decide (taste, direction, money, releases, deletions) as numbered options with your recommendation, after finishing everything else.
- Some calls (push, deploy, publish, paid generation APIs, deleting files you did not create, sudo, printing secrets) are held for the user. When one is held, do other work.`

// ---------------------------------------------------------------- learning

export const ANGRY = ['妈的', '他妈', '傻逼', '你TM', 'TM的', 'TMD', '卧槽', 'fuck', 'shit', '纸糊', '敷衍', '偷懒', '别墨迹', '废物']

export const isAngry = (text: string) => ANGRY.some(w => text.includes(w))

export function learnTask(rules: string, misses: readonly AutopilotMiss[], answers: readonly { title: string, question: string, choice: string }[]): string {
    const lines = misses.map(m => `- [${new Date(m.at).toISOString().slice(0, 16)} ${path.basename(m.cwd)}${m.angry ? ' ANGRY' : ''}] phase ${m.phase}\n  agent said: ${clip((m.reply ?? '').replace(/\s+/g, ' '), 300)}\n  supervisor had decided: ${m.decision ? `${m.decision.next} ${m.decision.rules.join(' ')} "${clip(m.decision.message ?? m.decision.reason, 200)}"` : '(nothing yet)'}\n  USER typed: ${clip(m.text, 800)}`)
    return [
        'You maintain the rulebook an autopilot supervisor uses to drive coding agents in a user\'s place. Below are the moments the user still had to step in while autopilot was on, and the decisions they made on cards. Each one is a judgement the rulebook failed to make for them.',
        section('Current rulebook', rules.trim() || '(empty)'),
        section('Where the user stepped in', lines.join('\n') || '(none)'),
        section('Decisions the user made on cards', answers.map(a => `- ${a.title}: ${a.question} → ${a.choice}`).join('\n') || '(none)'),
        section('Task', [
            '- A message after a "done" decision may simply be the user\'s next task. It is a miss only when it corrects, redoes or questions the finished work.',
            '- For each intervention, decide whether a rule could have produced it: what signal was visible, what check, what the user said. Generalise: one rule per kind of judgement, with the user\'s own words as its evidence. Interventions that are taste or direction are not rules; note recurring preferences (what they chose on cards) so the supervisor can prepare better candidates.',
            '- Keep the rulebook\'s structure and ids. Edit rules that misfired (ANGRY marks a failure the user felt strongly), add new ones with the next ids, remove nothing the evidence does not contradict.',
            '- Read only what you need; do not change any file.',
            '- Call submit_rules once with the complete new rulebook and a short summary of the changes.',
        ].join('\n')),
    ].join('\n')
}

// ---------------------------------------------------------------- files shared by sessions

export const autopilotDir = (agentDir: string) => path.join(agentDir, AUTOPILOT_DIR)

export function readConfig(agentDir: string): AutopilotConfig {
    try {
        const parsed = JSON.parse(readFileSync(path.join(autopilotDir(agentDir), 'config.json'), 'utf8'))
        return {
            paid: Array.isArray(parsed?.paid) ? parsed.paid.filter((p: unknown) => typeof p === 'string' && p) : undefined,
            protected: Array.isArray(parsed?.protected) ? parsed.protected.filter((p: unknown) => typeof p === 'string' && p) : undefined,
        }
    }
    catch {
        return {}
    }
}

export function readRules(agentDir: string, cwd: string): string {
    const read = (file: string) => {
        try {
            return readFileSync(file, 'utf8')
        }
        catch {
            return ''
        }
    }
    const user = read(path.join(autopilotDir(agentDir), 'rules.md'))
    const project = read(path.join(cwd, '.pi', 'autopilot.md'))
    return [user, project && `## This project\n\n${project}`].filter(Boolean).join('\n\n')
}

/** Rename over the old file, so readers never see half of one. */
function writeAtomic(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, file)
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0)
        return true
    }
    catch (error: any) {
        return error?.code === 'EPERM'
    }
}

const boardFile = (agentDir: string, session: string) => path.join(autopilotDir(agentDir), 'board', `${session}.json`)

export function writePeer(agentDir: string, peer: AutopilotPeer) {
    try {
        writeAtomic(boardFile(agentDir, peer.session), JSON.stringify(peer))
    }
    catch {}
}

export function removePeer(agentDir: string, session: string) {
    rmSync(boardFile(agentDir, session), { force: true })
    try {
        // Only when empty: mail sent to an ended session waits for it to be resumed.
        rmdirSync(mailDir(agentDir, session))
    }
    catch {}
}

/** Every live session on the board; files of exited processes are removed on the way. */
export function readPeers(agentDir: string): AutopilotPeer[] {
    const dir = path.join(autopilotDir(agentDir), 'board')
    let names: string[]
    try {
        names = readdirSync(dir).filter(n => n.endsWith('.json'))
    }
    catch {
        return []
    }
    const peers: AutopilotPeer[] = []
    for (const name of names) {
        try {
            const peer = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as AutopilotPeer
            if (typeof peer.pid === 'number' && alive(peer.pid))
                peers.push(peer)
            else
                rmSync(path.join(dir, name), { force: true })
        }
        catch {}
    }
    return peers
}

export const mailDir = (agentDir: string, session: string) => path.join(autopilotDir(agentDir), 'mail', session)

let mailSeq = 0

export function sendMail(agentDir: string, session: string, mail: AutopilotMail) {
    // Time, then a per-process counter: names sort in sending order even within one millisecond.
    const name = `${String(Date.now()).padStart(15, '0')}-${String(++mailSeq).padStart(6, '0')}-${process.pid}.json`
    writeAtomic(path.join(mailDir(agentDir, session), name), JSON.stringify(mail))
}

/** Mail for this session, oldest first; read mail is removed. */
export function takeMail(agentDir: string, session: string): AutopilotMail[] {
    const dir = mailDir(agentDir, session)
    let names: string[]
    try {
        names = readdirSync(dir).filter(n => n.endsWith('.json')).sort()
    }
    catch {
        return []
    }
    const out: AutopilotMail[] = []
    for (const name of names) {
        const file = path.join(dir, name)
        try {
            out.push(JSON.parse(readFileSync(file, 'utf8')))
        }
        catch {}
        rmSync(file, { force: true })
    }
    return out
}

const missesFile = (agentDir: string) => path.join(autopilotDir(agentDir), 'misses.jsonl')

export function recordMiss(agentDir: string, miss: AutopilotMiss) {
    try {
        mkdirSync(autopilotDir(agentDir), { recursive: true })
        appendFileSync(missesFile(agentDir), `${JSON.stringify(miss)}\n`)
    }
    catch {}
}

/** Recorded interventions after `since` (ms). */
export function readMisses(agentDir: string, since = 0): AutopilotMiss[] {
    try {
        return readFileSync(missesFile(agentDir), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
            try {
                const miss = JSON.parse(line) as AutopilotMiss
                return miss.at > since ? [miss] : []
            }
            catch {
                return []
            }
        })
    }
    catch {
        return []
    }
}

/** Writes the new rulebook, keeping the old one next to it; returns the backup's path. */
export function writeRules(agentDir: string, text: string): string {
    const file = path.join(autopilotDir(agentDir), 'rules.md')
    const backup = path.join(autopilotDir(agentDir), `rules.${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
    try {
        writeAtomic(backup, readFileSync(file, 'utf8'))
    }
    catch {}
    writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`)
    const stamp = path.join(autopilotDir(agentDir), 'learned.json')
    writeAtomic(stamp, JSON.stringify({ at: Date.now() }))
    return backup
}

export function lastLearned(agentDir: string): number {
    try {
        const at = JSON.parse(readFileSync(path.join(autopilotDir(agentDir), 'learned.json'), 'utf8'))?.at
        return typeof at === 'number' ? at : 0
    }
    catch {
        return 0
    }
}
