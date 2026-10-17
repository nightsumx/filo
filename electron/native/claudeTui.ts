// Claude Code through its own TUI: the thread runs the user's unmodified `claude` in a terminal the
// app holds (Terminals.run), and the GUI is a projection of that one process.
//
//   - what the thread shows is Claude Code's session file folded into pi messages (claudeLog.ts),
//     read as it grows;
//   - whether a turn runs, what waits on the user and the streamed text come from its hooks
//     (claudeHooks.ts), which only report: nothing is decided outside the TUI;
//   - what the GUI does turns into keys, as the user would type them: a prompt is a bracketed paste
//     and Enter, stop is Esc, an approval is the dialog's number key.
//
// Sign-in, the folder-trust question, menus and anything else the GUI does not know show as the TUI
// itself (`tui_view` events), in the same thread. The user can type in the TUI at any time; the GUI
// then waits rather than mix its keys into a half-typed line.

import type { AcpAgentCaps, AcpAgentSpec } from '@shared/agents'
import type { ApprovalChoice, ApprovalRequest, AskQuestion, AskResponse } from '@shared/capabilities'
import type { SessionItem } from '@shared/ipc'
import type { ImageContent, PiEvent, RpcResponse } from '@shared/pi'
import type { AgentAdapter, AgentAdapterCallbacks, AgentAdapterOptions } from '../acp/adapter'
import type { Terminals } from '../terminals'
import type { ListedSession } from '../acp/list'
import { acpSessionKey } from '@shared/agents'
import { APPROVAL_TITLE_PREFIX } from '@shared/capabilities'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pricedModel } from 'pi-capabilities/lib/prices.ts'
import { askQuestions } from '../acp/transcript'
import { platform } from '../platform'
import { priceList } from '../prices'
import { tr } from '../i18n'
import { claudeCommands } from './claudeCommands'
import { ClaudeLog, parseLines, readRecords } from './claudeLog'
import { registerHooks } from './claudeHooks'

export const CLAUDE_TUI_CAPS: AcpAgentCaps = {
    images: true,
    // A prompt sent mid-turn queues in the TUI, which hands it to the model between steps.
    steering: true,
    fork: false,
    delete: false,
    list: true,
    rename: true,
    xai: false,
    ask: true,
}

let terminals: Terminals | null = null
let prefsFile = ''

/**
 * The terminals the TUI processes run in (main's, set at startup), and where the app keeps what the
 * user chose for them (hooks turned on for Filo's threads).
 */
export function useTerminals(t: Terminals, prefs = '') {
    terminals = t
    prefsFile = prefs
}

interface Prefs {
    /** The user turned hooks on for Filo's threads, over a `disableAllHooks` in their settings. */
    enableHooks?: boolean
}

function readPrefs(): Prefs {
    try {
        return JSON.parse(readFileSync(prefsFile, 'utf8')) ?? {}
    }
    catch {
        return {}
    }
}

function writePrefs(prefs: Prefs) {
    if (prefsFile)
        writeFileSync(prefsFile, JSON.stringify(prefs, null, 2))
}

// ---------------------------------------------------------------- whether hooks will run

/**
 * Why the GUI cannot follow the TUI: its hooks are off. `disabled`: the user's or the project's
 * settings say `disableAllHooks` (Filo can turn them on for its threads); `policy`: an
 * administrator's settings do (it cannot); `silent`: none of the settings Filo reads, but the
 * hooks do not come (managed by MDM or the server, or a Claude Code that changed).
 */
export interface HooksIssue {
    cause: 'disabled' | 'policy' | 'silent'
    /** The settings files that turn them off. */
    files: string[]
    /** Filo turned them on already, and they still do not come. */
    tried?: boolean
}

/** The folders administrators put managed-settings.json in (and managed-settings.d beside it). */
function managedDirs(): string[] {
    if (platform.id === 'darwin')
        return ['/Library/Application Support/ClaudeCode']
    if (platform.id === 'win32')
        return [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')]
    return ['/etc/claude-code']
}

function readJson(file: string): Record<string, any> | undefined {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'))
        return value && typeof value === 'object' ? value : undefined
    }
    catch {
        return undefined
    }
}

/** What the settings files say about hooks, before the process starts. */
export function hookSettings(dir: string, cwd: string, managed = managedDirs()): { issue?: HooksIssue, urlAllowlist: boolean } {
    const policy: [string, Record<string, any>][] = []
    for (const folder of managed) {
        const base = path.join(folder, 'managed-settings.json')
        const json = readJson(base)
        if (json)
            policy.push([base, json])
        try {
            for (const name of readdirSync(path.join(folder, 'managed-settings.d')).filter(n => n.endsWith('.json')).sort()) {
                const file = path.join(folder, 'managed-settings.d', name)
                const value = readJson(file)
                if (value)
                    policy.push([file, value])
            }
        }
        catch {}
    }
    const own: [string, Record<string, any>][] = []
    for (const file of [path.join(dir, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
        const json = readJson(file)
        if (json)
            own.push([file, json])
    }
    const urlAllowlist = [...policy, ...own].some(([, json]) => Array.isArray(json.allowedHttpHookUrls))
    const blocking = policy.filter(([, json]) => json.disableAllHooks === true || json.allowManagedHooksOnly === true)
    if (blocking.length)
        return { issue: { cause: 'policy', files: blocking.map(([file]) => file) }, urlAllowlist }
    const disabled = own.filter(([, json]) => json.disableAllHooks === true)
    if (disabled.length)
        return { issue: { cause: 'disabled', files: disabled.map(([file]) => file) }, urlAllowlist }
    return { urlAllowlist }
}

/**
 * The app's own environment that must not reach the TUI: a parent Claude Code session (it would
 * refuse to nest, report to it, or take itself for its child and not save its transcript), and an
 * IDE's (an app started from a JetBrains IDE's terminal carries its bundle id, and Claude Code then
 * greets the IDE and tries to connect to it).
 */
const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'AI_AGENT', 'ENABLE_IDE_INTEGRATION', 'TERMINAL_EMULATOR', 'ELECTRON_RUN_AS_NODE', '__CFBundleIdentifier']

/**
 * What `/model` and `/effort` take. The model names are the aliases Claude Code resolves itself (to whatever
 * the current Opus, Sonnet, Haiku are), so they do not age with its releases; the efforts are its levels.
 * Picking one types the command into the TUI, which also writes it to Claude Code's own settings.json, as it
 * does in a terminal. Neither is validated by Claude Code (an unknown name is accepted), so only these are sent.
 */
const MODEL_ALIASES = [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }]
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh']

/** What /autocompact is given for a window of tokens (100K to 1M, in thousands) or 'auto'. */
export function autoCompactWindow(value: unknown): string {
    if (value === 'auto')
        return 'auto'
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100_000 || value > 1_000_000)
        throw new Error(tr('自动压缩的阈值要在 10 万到 100 万 token 之间', 'The auto-compact window is between 100,000 and 1,000,000 tokens'))
    return `${Math.round(value / 1000)}k`
}

/** Claude Code's folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeDir(env: Record<string, string | undefined> = process.env): string {
    return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/** The folder Claude Code keeps a project's sessions in: the real path, every other character a dash. */
export function projectSlug(cwd: string): string {
    let real = cwd
    try {
        real = realpathSync.native(cwd)
    }
    catch {}
    return real.replace(/[^a-z0-9]/gi, '-')
}

/** The session file: in the project's folder, else wherever Claude Code put it (a moved project). */
export function sessionFile(dir: string, cwd: string, sessionId: string): string {
    const expected = path.join(dir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`)
    if (existsSync(expected))
        return expected
    try {
        for (const project of readdirSync(path.join(dir, 'projects'))) {
            const file = path.join(dir, 'projects', project, `${sessionId}.jsonl`)
            if (existsSync(file))
                return file
        }
    }
    catch {}
    return expected
}

/** Bracketed paste, so newlines stay in the input; a paste-end inside the text would end it early. */
const paste = (text: string) => `\x1B[200~${text.replaceAll('\x1B[201~', '')}\x1B[201~`
/** xterm's focus reports (mode 1004), sent as the terminal gains or loses focus. */
const FOCUS_IN = `${String.fromCharCode(27)}[I`
const FOCUS_OUT = `${String.fromCharCode(27)}[O`
const ESC = '\x1B'
/** How long the thread waits, after PostCompact, for the summary to reach the session file. */
const SUMMARY_WAIT_MS = 8000
const ENTER = '\r'
/** How long the TUI gets to come up before the thread shows it (a question it asks first). */
const STARTUP_GRACE_MS = 2500
/** A submitted prompt's record lands within this; a hook-only turn (none) does not hold the thread. */
const PROMPT_RECORD_MS = 8000
/** How long a slash command may leave no trace before it counts as answered on the TUI's screen. */
const SCREEN_ONLY_MS = 3000
/** A prompt in the file with no UserPromptSubmit this long after: the hooks do not come. */
const HOOK_SILENCE_MS = 3000
const SLEEP = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface Approval {
    id: string
    toolUseId: string
    /** `tui`: a dialog only the TUI answers, shown there or taken up there by the user's keys. */
    kind: 'approval' | 'ask' | 'tui'
    questions?: AskQuestion[]
}

export class ClaudeTuiAgent implements AgentAdapter {
    readonly id = randomUUID()
    readonly caps = CLAUDE_TUI_CAPS
    readonly ready: Promise<void>
    private log: ClaudeLog
    private file: string
    private offset = 0
    private session: string
    private dir: string
    private terminal = ''
    private settingsFile = ''
    private disposeHooks: (() => void) | null = null
    private exited = false
    private running = false
    /** A prompt was submitted (hook) and its record is not in yet. */
    private awaiting: { prompts: number, until: number } | null = null
    /**
     * Text shown before the prompt's record is in the file (Claude Code writes it in batches): it
     * would land ahead of the prompt, so it waits for it.
     */
    private early: { delta: string, key: string }[] = []
    /** SessionStart came: the TUI is at its prompt. */
    private started = false
    private startedWaiters: (() => void)[] = []
    /** Not started within STARTUP_GRACE_MS: the TUI probably asks something first. */
    private slowStart = false
    /** Characters the user typed in the TUI's input since the last submit: a GUI prompt would join their line. */
    private dirty = 0
    /** Between PreCompact and PostCompact: Claude Code is summarising the conversation. */
    private compacting = false
    private compactionsBefore = 0
    private outputsBefore = 0
    /** A command was answered on the TUI's screen, maybe in a dialog (/cost) that takes the next keys. */
    private screenDialog = false
    private lastPre: { name: string, input: string, id: string } | null = null
    private waits = new Map<string, Approval>()
    private model = ''
    private permissionMode = ''
    private poll: ReturnType<typeof setInterval> | null = null
    private idlePoll: ReturnType<typeof setInterval> | null = null
    private stopTimer: ReturnType<typeof setTimeout> | null = null
    private titleSent = ''
    private named = false
    /**
     * Hooks that will not come (see HooksIssue). The thread then follows the session file alone:
     * the transcript stays current, the TUI is in view for what only it shows, and a GUI prompt
     * goes in only while the TUI is surely at its prompt.
     */
    private hooksIssue: HooksIssue | undefined
    /** UserPromptSubmit events, against the file's prompts (`fold.asked`) to tell silent hooks. */
    private submitted = 0
    /** `fold.asked` when this process started; prompts before it were not this process's. */
    private askedAtStart = 0
    private silenceTimer: ReturnType<typeof setTimeout> | null = null
    /** The process wrote to the session file: past sign-in and the folder-trust question. */
    private wrote = false
    private relaunching = false
    /** A model picked in the app: shown until the session file shows the model that answered (its alias, not the full id). */
    private picked?: { alias: string, over?: string }
    /** The effort picked in the app, which Claude Code does not report back. */
    private effort?: string

    constructor(readonly spec: AcpAgentSpec, private launch: { file: string, args: string[], env: Record<string, string> }, private options: AgentAdapterOptions, private callbacks: AgentAdapterCallbacks) {
        this.dir = claudeDir(launch.env)
        this.session = options.sessionId ?? randomUUID()
        this.file = sessionFile(this.dir, options.cwd, this.session)
        this.log = new ClaudeLog(`${this.session}:`, { emit: e => this.emit(e) })
        this.ready = this.open()
        this.ready.catch(() => {})
    }

    get key(): string {
        return acpSessionKey(this.spec.id, this.session)
    }

    get cwd(): string {
        return this.options.cwd
    }

    get sessionId(): string {
        return this.session
    }

    snapshot(): SessionItem[] {
        return this.log.transcript.snapshot()
    }

    private emit(event: PiEvent) {
        if (!this.options.readOnly)
            this.callbacks.onEvent(this.id, event)
    }

    private async open() {
        const resume = existsSync(this.file)
        // History first, quietly: the thread loads it as the snapshot.
        this.log.transcript.setEmitter(() => {})
        this.tail()
        this.log.fold.settle()
        this.log.transcript.setEmitter(e => this.emit(e))
        if (this.options.readOnly)
            return
        await this.launchTui()
        if (resume)
            this.callbacks.onSession?.(this, { title: this.title() })
    }

    /** Starts `claude` in a terminal of the app's, with the hooks that report to this adapter. */
    private async launchTui() {
        if (!terminals)
            throw new Error('terminals are not ready')
        const resume = existsSync(this.file)
        const found = hookSettings(this.dir, this.options.cwd)
        const override = !!readPrefs().enableHooks
        // Flag settings come before the user's and the project's (not an administrator's).
        this.hooksIssue = found.issue?.cause === 'disabled' && override ? undefined : found.issue
        const hooks = await registerHooks(event => this.hook(event), found.urlAllowlist ? 'command' : 'http')
        this.disposeHooks = hooks.dispose
        // A command typed in the TUI that only prints (/cost, /context) fires no hook; its record is picked up from the file.
        this.idlePoll ??= setInterval(() => {
            if (!this.running && !this.exited)
                this.tail()
        }, 2000)
        const settings: Record<string, unknown> = { ...hooks.settings }
        if (override)
            settings.disableAllHooks = false
        const env: Record<string, string> = { ...this.launch.env }
        for (const name of STRIP_ENV)
            delete env[name]
        // A thread on a route group (routes.ts) gets the gateway as its endpoint. Flag settings come
        // before the user's own (~/.claude/settings.json may name another endpoint), and a token
        // spares the TUI's "use this API key?" question.
        if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== process.env.ANTHROPIC_BASE_URL) {
            settings.env = { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_API_KEY ?? '' }
            delete env.ANTHROPIC_API_KEY
        }
        const tmp = path.join(os.tmpdir(), 'filo-claude')
        mkdirSync(tmp, { recursive: true, mode: 0o700 })
        this.settingsFile = path.join(tmp, `${this.id}.json`)
        this.started = false
        this.slowStart = false
        this.wrote = false
        this.submitted = 0
        this.askedAtStart = this.log.fold.asked
        writeFileSync(this.settingsFile, JSON.stringify(settings), { mode: 0o600 })
        const args = [...(resume ? ['--resume', this.session] : ['--session-id', this.session]), '--settings', this.settingsFile]
        let id = ''
        id = terminals.run({ cwd: this.options.cwd, cols: 100, rows: 30, label: 'Claude Code' }, {
            file: this.launch.file,
            args: [...this.launch.args, ...args],
            env,
            onInput: data => this.typed(data),
            // A process the adapter replaced (relaunch) ends without ending the thread.
            onExit: (exit) => {
                if (this.terminal === id)
                    this.processExited(exit)
            },
        })
        this.terminal = id
        this.emit({ type: 'state_changed' })
        if (this.hooksIssue)
            this.hooksOff(this.hooksIssue)
        const terminal = this.terminal
        setTimeout(() => {
            if (!this.started && !this.exited && this.terminal === terminal) {
                this.slowStart = true
                this.emit({ type: 'tui_view', show: true, reason: 'starting' })
            }
        }, STARTUP_GRACE_MS)
    }

    /** The hooks will not come: follow the file alone, show the TUI, and say why in the thread. */
    private hooksOff(issue: HooksIssue) {
        this.hooksIssue = issue
        this.poll ??= setInterval(() => this.tail(), 1000)
        this.emit({ type: 'tui_view', show: true, reason: 'hooks' })
        this.emit({ type: 'state_changed' })
    }

    /**
     * Turns hooks on for Filo's threads (flag settings over the user's `disableAllHooks`) and starts
     * the TUI again on the same session; remembered for the next ones.
     */
    private async enableHooks() {
        if (this.running)
            throw new Error(tr('等这一轮结束', 'Wait for the turn to finish'))
        writePrefs({ ...readPrefs(), enableHooks: true })
        await this.relaunch()
    }

    /** The same session in a new process: what changed in the settings applies. */
    private async relaunch() {
        const old = this.terminal
        this.relaunching = true
        try {
            this.dispose()
            if (old)
                await terminals?.close(old)
        }
        finally {
            this.relaunching = false
        }
        this.exited = false
        this.terminal = ''
        await this.launchTui()
    }

    /** The /goal condition the thread last heard of. */
    private goalSent: string | undefined

    private title(): string | undefined {
        return this.log.meta.customTitle ?? this.log.meta.aiTitle
    }

    /** Takes what the session file gained; follows the session's running state from it. */
    private tail() {
        const { records, offset } = readRecords(this.file, this.offset)
        this.offset = offset
        if (records.length && this.terminal)
            this.wrote = true
        if (records.length && this.log.add(records))
            this.emit({ type: 'agent_settled' })
        if (this.log.meta.goal !== this.goalSent) {
            this.goalSent = this.log.meta.goal
            this.emit({ type: 'state_changed' })
        }
        const title = this.title()
        if (title && title !== this.titleSent) {
            this.titleSent = title
            if (this.started || this.named)
                this.callbacks.onSession?.(this, { title })
        }
        if (this.awaiting && (this.log.fold.prompts > this.awaiting.prompts || Date.now() > this.awaiting.until)) {
            this.awaiting = null
            for (const { delta, key } of this.early.splice(0))
                this.log.fold.stream(delta, key)
        }
        // The /compact command printed its result without a PostCompact (too little to compact): it is over.
        if (this.compacting && this.log.fold.outputs > this.outputsBefore)
            this.endCompaction('manual')
        this.watchSilence()
        this.syncRunning()
    }

    /** A prompt the model got with no UserPromptSubmit for it: the hooks are not running. */
    private watchSilence() {
        if (this.hooksIssue || this.silenceTimer || !this.terminal)
            return
        if (this.log.fold.asked - this.askedAtStart <= this.submitted)
            return
        this.silenceTimer = setTimeout(() => {
            this.silenceTimer = null
            if (this.hooksIssue || this.exited || this.log.fold.asked - this.askedAtStart <= this.submitted)
                return
            const found = hookSettings(this.dir, this.options.cwd).issue
            // Turned on by Filo already and still silent: something it cannot change.
            this.hooksOff(found?.cause === 'policy' ? found : { cause: 'silent', files: [], tried: !!readPrefs().enableHooks })
            this.syncRunning()
        }, HOOK_SILENCE_MS)
    }

    private syncRunning() {
        const busy = this.log.fold.turnOpen || !!this.awaiting
        if (busy && !this.running) {
            this.running = true
            this.emit({ type: 'agent_start' })
            this.poll ??= setInterval(() => this.tail(), 300)
        }
        else if (!busy && this.running) {
            this.running = false
            this.early = []
            // Without hooks the file is all there is to follow: it keeps being read.
            if (this.poll && !this.hooksIssue) {
                clearInterval(this.poll)
                this.poll = null
            }
            this.closeWaits()
            this.emit({ type: 'agent_end' })
            this.emit({ type: 'agent_settled' })
            this.callbacks.onSession?.(this, {})
        }
    }

    // ---------------------------------------------------------------- hooks

    private hook(event: Record<string, any>) {
        if (this.exited)
            return
        this.hooksAlive()
        const name = String(event.hook_event_name ?? '')
        // /clear starts another session in the same process.
        if (typeof event.session_id === 'string' && event.session_id && event.session_id !== this.session && name === 'SessionStart')
            this.switchSession(event.session_id, String(event.transcript_path ?? ''))
        if (typeof event.transcript_path === 'string' && event.transcript_path && event.session_id === this.session)
            this.file = event.transcript_path
        if (typeof event.permission_mode === 'string')
            this.permissionMode = event.permission_mode
        this.tail()
        switch (name) {
            case 'SessionStart':
                if (typeof event.model === 'string')
                    this.model = event.model
                this.markStarted()
                break
            case 'UserPromptSubmit':
                this.markStarted()
                this.submitted++
                this.dirty = 0
                this.awaiting = { prompts: this.log.fold.prompts, until: Date.now() + PROMPT_RECORD_MS }
                if (!this.named && typeof event.prompt === 'string') {
                    this.named = true
                    this.callbacks.onSession?.(this, { prompt: event.prompt })
                }
                this.syncRunning()
                break
            case 'PreToolUse':
                this.lastPre = { name: String(event.tool_name ?? ''), input: JSON.stringify(event.tool_input ?? null), id: String(event.tool_use_id ?? '') }
                break
            case 'PermissionRequest':
                void this.permission(event)
                break
            case 'PostToolUse':
            case 'PostToolUseFailure':
            case 'PermissionDenied':
                this.closeWaits(String(event.tool_use_id ?? ''))
                break
            case 'MessageDisplay':
                if (!this.running || typeof event.delta !== 'string')
                    break
                if (this.awaiting)
                    this.early.push({ delta: event.delta, key: String(event.message_id ?? '') })
                else
                    this.log.fold.stream(event.delta, String(event.message_id ?? ''))
                break
            case 'Notification':
                // A form from an MCP server, or Claude Code waiting on something only the TUI shows.
                if (event.notification_type === 'elicitation_dialog')
                    this.emit({ type: 'tui_view', show: true, reason: 'dialog' })
                break
            case 'PreCompact':
                this.compacting = true
                this.compactionsBefore = this.log.fold.compactions
                this.outputsBefore = this.log.fold.outputs
                this.emit({ type: 'compaction_start', reason: event.trigger === 'auto' ? 'threshold' : 'manual' })
                break
            case 'PostCompact':
                this.endCompaction(event.trigger === 'auto' ? 'threshold' : 'manual', true)
                break
            case 'Stop':
            case 'StopFailure':
                this.endCompaction('manual')
                this.afterStop(name === 'StopFailure' ? String(event.error ?? event.message ?? '') : '')
                break
            default:
                break
        }
    }

    /**
     * Compaction is over: PostCompact, or the turn it was part of ended without one (as when it failed).
     * Claude Code writes the summary to the session file a little after PostCompact, and the thread reads
     * it back when the compaction ends: so this waits (a few seconds at most) for the summary to be there.
     */
    private endCompaction(reason: 'manual' | 'threshold', waitForSummary = false) {
        if (!this.compacting)
            return
        const done = () => {
            if (!this.compacting)
                return
            this.compacting = false
            this.emit({ type: 'compaction_end', reason, aborted: false })
        }
        const until = Date.now() + SUMMARY_WAIT_MS
        const check = () => {
            this.tail()
            if (this.exited || !this.compacting)
                return
            if (this.log.fold.compactions > this.compactionsBefore || Date.now() > until)
                return done()
            setTimeout(check, 150)
        }
        if (waitForSummary)
            check()
        else
            done()
    }

    /** Hooks that come are working, whatever the settings looked like. */
    private hooksAlive() {
        if (!this.hooksIssue)
            return
        this.hooksIssue = undefined
        this.emit({ type: 'state_changed' })
        this.emit({ type: 'tui_view', show: false, reason: 'hooks' })
        if (!this.running && this.poll) {
            clearInterval(this.poll)
            this.poll = null
        }
    }

    private markStarted() {
        if (this.started)
            return
        this.started = true
        this.emit({ type: 'tui_view', show: false, reason: 'starting' })
        // Started again with hooks turned on: the TUI it showed for them goes.
        this.emit({ type: 'tui_view', show: false, reason: 'hooks' })
        this.startedWaiters.splice(0).forEach(f => f())
    }

    /** The turn's last records land after Stop; one that never gets turn_duration settles anyway. */
    private afterStop(error: string) {
        for (const ms of [150, 500])
            setTimeout(() => this.tail(), ms)
        if (this.stopTimer)
            clearTimeout(this.stopTimer)
        const prompts = this.log.fold.prompts
        this.stopTimer = setTimeout(() => {
            this.stopTimer = null
            this.tail()
            if (this.log.fold.turnOpen && this.log.fold.prompts === prompts && !this.awaiting) {
                if (error)
                    this.log.transcript.finish('end_turn', undefined, error)
                this.log.fold.settle()
                this.syncRunning()
            }
        }, 2000)
    }

    private switchSession(sessionId: string, file: string) {
        this.closeWaits()
        this.session = sessionId
        this.file = file || sessionFile(this.dir, this.options.cwd, sessionId)
        this.offset = 0
        this.named = false
        this.titleSent = ''
        this.submitted = 0
        this.askedAtStart = 0
        this.log = new ClaudeLog(`${sessionId}:`, { emit: e => this.emit(e) })
        this.callbacks.onFork?.(this, sessionId)
        this.callbacks.onSession?.(this, {})
        this.emit({ type: 'state_changed' })
        this.emit({ type: 'agent_settled' })
    }

    // ---------------------------------------------------------------- permissions

    /** A permission dialog in the TUI: shown as an approval (or the ask form), answered with its keys. */
    private async permission(event: Record<string, any>) {
        const toolName = String(event.tool_name ?? '')
        const input = event.tool_input ?? {}
        const pre = this.lastPre
        const toolUseId = pre && pre.name === toolName ? pre.id : ''
        if (!toolUseId) {
            this.emit({ type: 'tui_view', show: true, reason: 'dialog' })
            return
        }
        // Held until the call ends, so a GUI prompt does not go into the dialog as its answer.
        const inTui = () => {
            this.waits.set(toolUseId, { id: toolUseId, toolUseId, kind: 'tui' })
            this.emit({ type: 'tui_view', show: true, reason: 'dialog' })
        }
        if (toolName === 'AskUserQuestion') {
            const questions = askQuestions(input.questions)
            // One single-choice question maps onto its number keys; the rest is the TUI's own form.
            if (questions.length !== 1 || questions[0].multiple || !questions[0].options.length) {
                inTui()
                return
            }
            for (let i = 0; i < 10; i++) {
                if (this.log.transcript.setDetails(toolUseId, { kind: 'ask', status: 'pending', questions })) {
                    this.waits.set(toolUseId, { id: toolUseId, toolUseId, kind: 'ask', questions })
                    return
                }
                await SLEEP(150)
                this.tail()
            }
            inTui()
            return
        }
        if (toolName === 'ExitPlanMode') {
            inTui()
            return
        }
        const always = alwaysLabel(event.permission_suggestions)
        const shown = this.log.transcript.callsOf(toolUseId)
        const approval: ApprovalRequest = {
            toolCallId: shown[0]?.id ?? toolUseId,
            tool: shown[0]?.name ?? toolName,
            summary: summaryOf(toolName, input),
            scope: always ? 'claude' : '',
            alwaysLabel: always,
        }
        const id = `claude-approval-${randomUUID()}`
        const choices: ApprovalChoice[] = always ? ['allow', 'always', 'deny'] : ['allow', 'deny']
        this.waits.set(id, { id, toolUseId, kind: 'approval' })
        this.emit({ type: 'extension_ui_request', id, method: 'select', title: `${APPROVAL_TITLE_PREFIX}${JSON.stringify(approval)}`, options: choices })
    }

    /** The GUI's answer to an approval: the dialog's key, if the dialog is still there. */
    private answer(id: string, value: unknown) {
        const wait = this.waits.get(id)
        if (!wait || wait.kind !== 'approval' || !this.terminal)
            return
        this.waits.delete(id)
        // Yes is 1; the dialog's second option is what its first suggestion allows; Esc says no.
        const key = value === 'allow' ? '1' : value === 'always' ? '2' : ESC
        terminals?.inject(this.terminal, key)
    }

    private answerAsk(id: string, response: AskResponse) {
        const wait = this.waits.get(id)
        if (!wait || wait.kind !== 'ask' || !this.terminal)
            throw new Error(tr('这个问题已经不在等回答了', 'This question is no longer waiting for an answer'))
        const question = wait.questions![0]
        if ('cancelled' in response) {
            this.waits.delete(id)
            terminals?.inject(this.terminal, ESC)
            return
        }
        const answer = response.answers[question.id]
        const index = answer?.selected?.length === 1 && !answer.text?.trim() ? question.options.indexOf(answer.selected[0]) : -1
        if (index < 0 || index > 8) {
            // A typed answer goes in the TUI's own field.
            this.emit({ type: 'tui_view', show: true, reason: 'dialog' })
            throw new Error(tr('在终端里回答这个问题', 'Answer this question in the terminal'))
        }
        this.waits.delete(id)
        terminals?.inject(this.terminal, String(index + 1))
    }

    /** Dialogs that are gone (answered in the TUI, the call ran, the turn ended). */
    private closeWaits(toolUseId?: string) {
        for (const [id, wait] of this.waits) {
            if (toolUseId && wait.toolUseId !== toolUseId)
                continue
            this.waits.delete(id)
            if (wait.kind === 'approval')
                this.emit({ type: 'extension_ui_cancel', id })
        }
    }

    // ---------------------------------------------------------------- input

    /** Keys a window typed into the TUI: a line in progress there holds the GUI's prompts back. */
    private typed(data: string) {
        // The user is at the TUI: whatever it shows is theirs to close. (Not the focus reports the terminal sends
        // when its pane is shown or hidden: hiding the TUI after /cost is not closing its dialog.)
        if (data !== FOCUS_IN && data !== FOCUS_OUT)
            this.screenDialog = false
        // Sign-in and the folder question come before the prompt (no hooks: no telling when).
        if (!this.started && !this.hooksIssue)
            return
        // Keys for a dialog, not the input line: the user answers it there, and its card goes.
        if (this.waits.size) {
            if (data !== ESC && data.startsWith(ESC))
                return
            for (const wait of this.waits.values()) {
                if (wait.kind === 'approval')
                    this.emit({ type: 'extension_ui_cancel', id: wait.id })
                wait.kind = 'tui'
            }
            return
        }
        if (data.startsWith('\x1B[200~'))
            this.dirty += data.length
        else if (data.includes(ENTER) || data.includes('\x03') || data.includes('\x15'))
            this.dirty = 0
        else if (data === '\x7F' || data === '\b')
            this.dirty = Math.max(0, this.dirty - 1)
        else if (/^[^\x00-\x1F\x7F]/.test(data))
            this.dirty += [...data].length
    }

    private async whenStarted() {
        if (this.started)
            return
        if (this.hooksIssue) {
            // No SessionStart to wait for. Once the process has written to the session, sign-in and
            // the folder question are behind it; before that, keys could answer one of them.
            if (this.wrote && !this.running)
                return
            this.emit({ type: 'tui_view', show: true, reason: 'hooks' })
            throw new Error(this.running
                ? tr('Claude Code 的 hooks 没开，这一轮请在终端里跟进', 'Claude Code\'s hooks are off: follow this turn in the terminal')
                : tr('Claude Code 的 hooks 没开，先在终端里发第一条', 'Claude Code\'s hooks are off: send the first prompt in the terminal'))
        }
        // Within the grace the TUI is just coming up; past it, it is asking something.
        if (this.slowStart)
            this.emit({ type: 'tui_view', show: true, reason: 'starting' })
        await new Promise<void>(resolve => this.startedWaiters.push(resolve))
    }

    /** Types a prompt into the TUI as a paste, images as pasted file paths, then Enter. */
    private async prompt(text: string, images: ImageContent[]) {
        if (this.exited || !this.terminal)
            throw new Error(tr('Claude Code 已经退出', 'Claude Code has exited'))
        await this.whenStarted()
        if (this.dirty) {
            this.emit({ type: 'tui_view', show: true, reason: 'draft' })
            throw new Error(tr('终端里有没发出去的输入，先在那里发送或清掉', 'The terminal has unsent input; send or clear it there first'))
        }
        if (this.waits.size)
            throw new Error(tr('先回答 Claude Code 正在问的问题', 'Answer what Claude Code is asking first'))
        // The dialog a screen-only command left open would take this prompt's keys: close it, as the user would.
        if (this.screenDialog) {
            this.screenDialog = false
            terminals!.inject(this.terminal, ESC)
            await SLEEP(300)
        }
        for (const file of saveImages(images)) {
            terminals!.inject(this.terminal, paste(file))
            await SLEEP(120)
        }
        terminals!.inject(this.terminal, paste(text))
        await SLEEP(80)
        terminals!.inject(this.terminal, ENTER)
        // A busy TUI can take the Enter before the paste is in its line, as an empty submit; until
        // UserPromptSubmit says it went, Enter again (at an idle, empty prompt it does nothing).
        const terminal = this.terminal
        const before = this.submitted
        if (!this.running && !this.hooksIssue && !text.trim().startsWith('/'))
            void (async () => {
                for (let i = 0; i < 3; i++) {
                    await SLEEP(1500)
                    if (this.submitted !== before || this.running || this.waits.size || this.dirty || this.exited || this.terminal !== terminal)
                        return
                    terminals!.inject(terminal, ENTER)
                }
            })()
        // A command that opens a menu (/model, /config, …) is answered in the TUI.
        if (/^\/\S+$/.test(text.trim()) && !/^\/(compact|clear|cost|exit)$/.test(text.trim()))
            this.emit({ type: 'tui_view', show: true, reason: 'command' })
    }

    /** True when a prompt just sent left no trace (no hook, no record, no turn) for a few seconds. */
    private async screenOnly(was: { submitted: number, prompts: number }): Promise<boolean> {
        for (let waited = 0; waited < SCREEN_ONLY_MS; waited += 100) {
            await SLEEP(100)
            this.tail()
            if (this.submitted > was.submitted || this.log.fold.prompts > was.prompts || this.running || this.waits.size || this.exited)
                return false
        }
        return true
    }

    /** A prompt or command typed into the TUI; one that only draws on its screen (/cost, a dialog) puts the TUI in view. */
    private async send(message: string, images: ImageContent[] = []): Promise<RpcResponse> {
        const was = { running: this.running, submitted: this.submitted, prompts: this.log.fold.prompts }
        await this.prompt(message, images)
        // A command Claude Code answers on its screen only (/cost, /context in some versions) writes nothing
        // to the session file and fires no hook, so the thread would wait for a turn that never comes.
        if (!was.running && /^\/[\w:.-]+/.test(message.trim()) && !/^\/(compact|clear|exit)(\s|$)/.test(message.trim()) && await this.screenOnly(was)) {
            this.screenDialog = true
            this.emit({ type: 'tui_view', show: true, reason: 'command' })
            return { type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } }
        }
        return { type: 'response', command: 'prompt', success: true, data: {} }
    }

    /** A command that may open a yes/no dialog (first option "Yes"): typed, then answered Yes if the dialog shows. */
    private async typeAndConfirm(line: string, dialog: string) {
        const printed = this.log.fold.outputs
        await this.command(line)
        for (let waited = 0; waited < 4000; waited += 100) {
            await SLEEP(100)
            if (this.terminal && terminals?.screen(this.terminal).includes(dialog)) {
                terminals.inject(this.terminal, '1')
                return
            }
            this.tail()
            if (this.log.fold.outputs > printed)
                return
        }
    }

    private async command(line: string) {
        if (this.running)
            throw new Error(tr('等这一轮结束', 'Wait for the turn to finish'))
        await this.prompt(line, [])
    }

    /** The capability forms' hidden commands; false if not one. */
    private guiCommand(message: string): boolean {
        const m = /^\/gui-ask-answer (\S+) ([\s\S]+)$/.exec(message)
        if (!m)
            return false
        this.answerAsk(m[1], JSON.parse(m[2]))
        return true
    }

    // ---------------------------------------------------------------- pi RPC

    write(record: Record<string, unknown>) {
        if (record.type === 'extension_ui_response' && typeof record.id === 'string')
            this.answer(record.id, record.cancelled ? 'deny' : record.value)
    }

    async request(command: Record<string, unknown>): Promise<RpcResponse> {
        const type = String(command.type)
        const ok = (data?: unknown): RpcResponse => ({ type: 'response', command: type, success: true, data })
        try {
            await this.ready
            switch (type) {
                case 'get_state':
                    return ok({
                        model: this.piModel(),
                        isStreaming: this.running,
                        isCompacting: this.compacting,
                        sessionFile: this.key,
                        sessionId: this.session,
                        sessionName: this.title(),
                        thinkingLevel: this.effort,
                        configOptions: [],
                        agentCaps: this.caps,
                        tuiTerminal: this.terminal || undefined,
                        tuiHooks: this.hooksIssue,
                        permissionMode: this.permissionMode || this.log.meta.permissionMode,
                        goal: this.log.meta.goal,
                    })
                case 'get_available_models':
                    return ok({ models: MODEL_ALIASES.map(m => ({ ...m, provider: this.spec.label })) })
                case 'get_available_thinking_levels':
                    return ok({ levels: EFFORT_LEVELS })
                case 'set_model': {
                    const alias = MODEL_ALIASES.find(m => m.id === command.modelId)
                    if (!alias)
                        throw new Error(tr(`Claude Code 的模型在终端里选（${String(command.modelId)}）`, `Pick that Claude Code model in its terminal (${String(command.modelId)})`))
                    // With a history to re-read, Claude Code asks "Switch model?" first. The app asked the user already.
                    await this.typeAndConfirm(`/model ${alias.id}`, 'Switch model?')
                    this.picked = { alias: alias.id, over: this.log.meta.model }
                    return ok()
                }
                case 'set_thinking_level': {
                    const level = EFFORT_LEVELS.find(l => l === command.level)
                    if (!level)
                        throw new Error(tr(`Claude Code 没有「${String(command.level)}」这一档`, `Claude Code has no "${String(command.level)}" effort`))
                    await this.typeAndConfirm(`/effort ${level}`, 'Switch effort?')
                    this.effort = level
                    return ok()
                }
                case 'set_auto_compact': {
                    // /autocompact takes 100K to 1M tokens ("500k", "1m") or auto, and writes it under the current model in settings.json.
                    const window = autoCompactWindow(command.window)
                    await this.command(`/autocompact ${window}`)
                    return ok()
                }
                case 'get_commands':
                    // Its skills and custom commands, from the folders it reads. Its built-ins are on the app's own controls
                    // (and the terminal view); the TUI lists nothing a program can read.
                    return ok({ commands: await claudeCommands(this.dir, this.options.cwd) })
                case 'get_session_stats':
                    return ok({ tokens: this.log.transcript.totals(), cost: undefined })
                case 'prompt': {
                    const message = String(command.message ?? '')
                    if (this.guiCommand(message))
                        return ok({ disposition: 'handled' })
                    return this.send(message, Array.isArray(command.images) ? command.images as ImageContent[] : [])
                }
                case 'claude_enable_hooks':
                    await this.enableHooks()
                    return ok()
                case 'abort':
                    // Esc stops a running turn; when idle it would start the TUI's rewind instead.
                    if (this.running && this.terminal)
                        terminals?.inject(this.terminal, ESC)
                    return ok()
                case 'clear_queue':
                    return ok({ steering: [], followUp: [] })
                case 'compact': {
                    // The note goes on the command's line: one line, as the TUI's prompt takes it.
                    const note = String(command.customInstructions ?? '').replace(/\s+/g, ' ').trim()
                    await this.command(note ? `/compact ${note}` : '/compact')
                    return ok({})
                }
                case 'set_session_name': {
                    const name = String(command.name ?? '').trim().replace(/\s+/g, ' ')
                    if (!name)
                        throw new Error(tr('名字不能为空', 'The name is empty'))
                    // /rename is typed into its editor: only when nothing else is there or running.
                    if (this.running || this.dirty || !this.started)
                        throw new Error(tr('Claude Code 正忙，等它停下再改名', 'Claude Code is busy; rename once it stops'))
                    await this.prompt(`/rename ${name}`, [])
                    this.callbacks.onSession?.(this, { title: name })
                    return ok()
                }
                default:
                    return { type: 'response', command: type, success: false, error: tr(`在 Claude Code 的终端里做这个（${type}）`, `Do this in Claude Code's terminal (${type})`) }
            }
        }
        catch (error: any) {
            return { type: 'response', command: type, success: false, error: String(error?.message ?? error) }
        }
    }

    private piModel() {
        // A model picked in the app stands in until Claude Code answers with another one.
        if (this.picked && this.log.meta.model !== this.picked.over)
            this.picked = undefined
        // The model that answered last; the one SessionStart reported is only the start (it is not told of a /model).
        const id = this.picked?.alias ?? (this.log.meta.model || this.model)
        const cacheTtl = this.log.meta.cacheTtl
        return id ? { id, name: this.picked ? MODEL_ALIASES.find(m => m.id === id)?.name ?? id : id, provider: this.spec.label, promptCache: cacheTtl ? { short: cacheTtl } : pricedModel(priceList(), 'claude', id)?.promptCache } as any : undefined
    }

    private processExited(exit: { code: number, signal?: number }) {
        if (this.exited || this.relaunching)
            return
        this.exited = true
        this.tail()
        this.log.fold.settle()
        this.dispose()
        if (this.compacting) {
            this.compacting = false
            this.emit({ type: 'compaction_end', reason: 'manual', aborted: true })
        }
        if (this.running) {
            this.running = false
            this.emit({ type: 'agent_end' })
            this.emit({ type: 'agent_settled' })
        }
        const screen = this.terminal ? terminals?.screen(this.terminal) ?? '' : ''
        this.callbacks.onExit(this.id, { code: exit.code, signal: exit.signal ? String(exit.signal) : null, stderr: exit.code ? screen.trim().split('\n').slice(-12).join('\n') : '' })
    }

    private dispose() {
        this.disposeHooks?.()
        this.disposeHooks = null
        if (this.poll)
            clearInterval(this.poll)
        this.poll = null
        if (this.idlePoll)
            clearInterval(this.idlePoll)
        this.idlePoll = null
        if (this.stopTimer)
            clearTimeout(this.stopTimer)
        this.stopTimer = null
        if (this.silenceTimer)
            clearTimeout(this.silenceTimer)
        this.silenceTimer = null
        if (this.settingsFile)
            rmSync(this.settingsFile, { force: true })
        this.startedWaiters.splice(0)
    }

    async stop(): Promise<void> {
        if (!this.terminal || this.options.readOnly) {
            this.dispose()
            return
        }
        const id = this.terminal
        await terminals?.close(id)
        this.processExited({ code: 0 })
    }
}

// ---------------------------------------------------------------- helpers

/** What "always" allows, from the first of Claude Code's suggestions (its dialog's option 2). */
function alwaysLabel(suggestions: unknown): string | undefined {
    const first = Array.isArray(suggestions) ? suggestions[0] : undefined
    if (first?.type === 'addRules' && Array.isArray(first.rules) && first.rules.length) {
        const rules = first.rules.map((r: any) => (r?.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r?.toolName ?? ''))).filter(Boolean).join(', ')
        return tr(`以后都允许 ${rules}`, `Always allow ${rules}`)
    }
    if (first?.type === 'addDirectories' && Array.isArray(first.directories))
        return tr(`以后都允许访问 ${first.directories.join(', ')}`, `Always allow access to ${first.directories.join(', ')}`)
    if (first?.type === 'setMode' && first.mode === 'acceptEdits')
        return tr('本会话自动接受编辑', 'Accept edits for this session')
    return undefined
}

function summaryOf(toolName: string, input: any): string {
    if (typeof input?.command === 'string')
        return input.command
    if (typeof input?.file_path === 'string')
        return input.file_path
    if (typeof input?.url === 'string')
        return input.url
    const text = JSON.stringify(input ?? {})
    return text === '{}' ? toolName : text.slice(0, 300)
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Pasted images go in as files: Claude Code attaches an image whose path is pasted. */
function saveImages(images: ImageContent[]): string[] {
    if (!images.length)
        return []
    const dir = path.join(os.tmpdir(), 'filo-claude', 'images')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return images.map((image) => {
        const file = path.join(dir, `${randomUUID()}.${IMAGE_EXT[image.mimeType] ?? 'png'}`)
        writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 })
        return file
    })
}

// ---------------------------------------------------------------- the session list

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 256 * 1024
const listCache = new Map<string, { size: number, mtimeMs: number, session: ListedSession | null }>()

/** Reads `length` bytes at `position` as text. */
async function readSlice(file: string, position: number, length: number): Promise<string> {
    const handle = await openFile(file, 'r')
    try {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, position)
        return buffer.toString('utf8', 0, bytesRead)
    }
    finally {
        await handle.close()
    }
}

/** One session file as a list entry: its folder and first prompt from the start, its title from the end. */
async function listed(file: string, size: number, mtimeMs: number): Promise<ListedSession | null> {
    const head = parseLines(await readSlice(file, 0, Math.min(size, HEAD_BYTES))).records
    const tail = size > HEAD_BYTES ? parseLines(`\n${await readSlice(file, Math.max(0, size - TAIL_BYTES), TAIL_BYTES)}`).records.slice(1) : head
    const cwd = head.find(r => typeof r.cwd === 'string')?.cwd as string | undefined
    // Sessions the app's own side tasks made (claude -p) are not threads.
    if (!cwd || head.some(r => typeof r.entrypoint === 'string' && r.entrypoint !== 'cli' && r.type === 'user'))
        return null
    let custom: string | undefined
    let ai: string | undefined
    for (const r of [...head, ...tail]) {
        if (r.type === 'custom-title' && typeof r.customTitle === 'string')
            custom = r.customTitle
        else if (r.type === 'ai-title' && typeof r.aiTitle === 'string')
            ai = r.aiTitle
    }
    const title = custom ?? ai
    const hasPrompt = head.some(r => r.type === 'user' && !r.isMeta && !r.isSidechain) || size > HEAD_BYTES
    if (!hasPrompt)
        return null
    return { sessionId: path.basename(file, '.jsonl'), cwd, title, updatedAt: mtimeMs }
}

/** Every interactive session in Claude Code's folder, newest first. */
export async function listClaudeSessions(env: Record<string, string | undefined> = process.env): Promise<{ sessions: ListedSession[], complete: boolean }> {
    const root = path.join(claudeDir(env), 'projects')
    const sessions: ListedSession[] = []
    let projects: string[] = []
    try {
        projects = readdirSync(root)
    }
    catch {
        return { sessions, complete: true }
    }
    for (const project of projects) {
        let names: string[] = []
        try {
            names = readdirSync(path.join(root, project)).filter(n => n.endsWith('.jsonl'))
        }
        catch {
            continue
        }
        for (const name of names) {
            const file = path.join(root, project, name)
            try {
                const stat = statSync(file)
                const cached = listCache.get(file)
                let session = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached.session : undefined
                if (session === undefined) {
                    session = await listed(file, stat.size, stat.mtimeMs)
                    listCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, session })
                }
                if (session)
                    sessions.push(session)
            }
            catch {}
        }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return { sessions, complete: true }
}
