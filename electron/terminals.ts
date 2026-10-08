// The Terminal tool window's processes. Each terminal is a PTY (node-pty) running the user's login
// shell in a project folder, or one command in that shell. Terminals belong to the project, not to a
// window: any window showing the project shows them, a project moving between windows keeps them,
// and a reload picks them up again. They end when no window shows their project any more.
//
// Main keeps a headless xterm per terminal fed with the same output, so a window that attaches late
// (reload, another window, a moved project) gets the screen and scrollback as they are, not a replay
// of raw bytes cut at some arbitrary point. Output chunks are numbered: the snapshot says which chunk
// it is current to, and the window drops the ones it already has.
import type { TerminalCreate, TerminalInfo, TerminalSnapshot } from '@shared/ipc'
import type { IPty } from 'node-pty'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, chmodSync, constants, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal as Headless } from '@xterm/headless'
import { IPC } from '@shared/ipc'

const execFileAsync = promisify(execFile)

type NodePty = typeof import('node-pty')

/** A window that receives output (Electron's WebContents). */
export interface TerminalSink {
    readonly id: number
    send: (channel: string, ...args: unknown[]) => void
    isDestroyed: () => boolean
}

export interface TerminalsOptions {
    /** node-pty's folder: the package in development, Resources/node-pty when packaged. */
    ptyDir: string
    /** Every terminal, after any change. */
    onChange: (list: TerminalInfo[]) => void
    appVersion?: string
}

const SCROLLBACK = 10_000
/** Output batched per window message; a burst of small writes becomes one IPC message. */
const FLUSH_MS = 8
const FLUSH_BYTES = 256 * 1024
const POLL_MS = 1000
/** Processes that outlive SIGHUP/SIGTERM get SIGKILL after this. */
const KILL_GRACE_MS = 1500
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 24

interface Entry {
    info: TerminalInfo
    pty: IPty | null
    headless: Headless
    serializer: SerializeAddon
    /** Output chunks written so far. */
    seq: number
    /** Output not yet sent to the windows. */
    pending: string
    flushTimer: ReturnType<typeof setTimeout> | null
    sinks: Map<number, TerminalSink>
    label?: string
    shell: string
    cols: number
    rows: number
    /** Exit listeners of the current process (stop, restart). */
    exited: Set<() => void>
}

/** The user's shell; GUI apps usually have SHELL, else the account's. */
export function userShell(): string {
    const shell = process.env.SHELL || os.userInfo().shell
    return shell && path.isAbsolute(shell) ? shell : '/bin/zsh'
}

/**
 * The environment a terminal starts with: the app's own, minus what only concerns the app (Electron
 * flags, dev-server and test variables, which would leak into a dev server started there), plus what
 * terminal programs look at.
 */
export function terminalEnv(base: NodeJS.ProcessEnv, version?: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(base)) {
        if (value === undefined || key.startsWith('ELECTRON_') || key.startsWith('PI_GUI_') || key.startsWith('VITE_') || key === 'PI_KIT_HOST')
            continue
        env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Filo'
    if (version)
        env.TERM_PROGRAM_VERSION = version
    // Apps started from Finder get no locale; shells then mangle non-ASCII input and output.
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE)
        env.LANG = 'en_US.UTF-8'
    return env
}

/** Every process below `pid`, deepest last (from one `ps` listing). */
export async function descendants(pid: number): Promise<number[]> {
    let stdout = ''
    try {
        stdout = (await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout
    }
    catch {
        return []
    }
    const children = new Map<number, number[]>()
    for (const line of stdout.split('\n')) {
        const [child, parent] = line.trim().split(/\s+/).map(Number)
        if (!Number.isInteger(child) || !Number.isInteger(parent))
            continue
        const list = children.get(parent)
        if (list)
            list.push(child)
        else
            children.set(parent, [child])
    }
    const out: number[] = []
    const queue = [pid]
    while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
            out.push(child)
            queue.push(child)
        }
    }
    return out
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0)
        return true
    }
    catch {
        return false
    }
}

const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
        process.kill(pid, sig)
    }
    catch {}
}

/**
 * Lines of the headless screen and scrollback as plain text, wrapped rows joined back into their
 * line, trailing blank lines dropped.
 */
function plainText(term: Headless, maxLines: number): string {
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i)
        if (!line)
            continue
        const text = line.translateToString(true)
        if (line.isWrapped && lines.length)
            lines[lines.length - 1] += text
        else
            lines.push(text)
    }
    while (lines.length && !lines[lines.length - 1].trim())
        lines.pop()
    return lines.slice(-maxLines).join('\n')
}

export class Terminals {
    private entries = new Map<string, Entry>()
    private pty: NodePty | null = null
    private poll: ReturnType<typeof setInterval> | null = null
    private changeTimer: ReturnType<typeof setTimeout> | null = null

    constructor(private options: TerminalsOptions) {}

    private loadPty(): NodePty {
        if (this.pty)
            return this.pty
        // node-pty 1.1.0 ships spawn-helper without its executable bit; every spawn fails with
        // "posix_spawnp failed" until it has one. Packaged builds get it at build time.
        const helper = path.join(this.options.ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
        try {
            accessSync(helper, constants.X_OK)
        }
        catch {
            try {
                chmodSync(helper, statSync(helper).mode | 0o111)
            }
            catch {}
        }
        this.pty = createRequire(import.meta.url)(this.options.ptyDir) as NodePty
        return this.pty
    }

    list(): TerminalInfo[] {
        return [...this.entries.values()].map(e => ({ ...e.info }))
    }

    get(id: string): TerminalInfo | undefined {
        const info = this.entries.get(id)?.info
        return info && { ...info }
    }

    create(create: TerminalCreate, by: TerminalInfo['by'] = 'user'): TerminalInfo {
        const cwd = create.cwd
        if (!path.isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
            throw new Error(`not a folder: ${cwd}`)
        const cols = clampSize(create.cols, DEFAULT_COLS)
        const rows = clampSize(create.rows, DEFAULT_ROWS)
        const shell = userShell()
        const headless = new Headless({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
        const serializer = new SerializeAddon()
        headless.loadAddon(serializer as never)
        const command = create.command?.trim() || undefined
        const entry: Entry = {
            info: { id: randomUUID(), cwd, title: create.label?.trim() || (command ? commandTitle(command) : path.basename(shell)), busy: !!command, command, by, createdAt: Date.now() },
            pty: null,
            headless,
            serializer,
            seq: 0,
            pending: '',
            flushTimer: null,
            sinks: new Map(),
            label: create.label?.trim() || undefined,
            shell,
            cols,
            rows,
            exited: new Set(),
        }
        this.entries.set(entry.info.id, entry)
        try {
            this.spawn(entry)
        }
        catch (error) {
            this.entries.delete(entry.info.id)
            headless.dispose()
            throw error
        }
        this.poll ??= setInterval(() => this.pollTitles(), POLL_MS)
        this.changed()
        return { ...entry.info }
    }

    private spawn(entry: Entry) {
        const { command } = entry.info
        // A login shell, so PATH and the rest come from the user's profile, as in Terminal.app.
        // A command runs in an interactive one too: version managers (fnm, nvm) set up in .zshrc.
        const args = command ? ['-i', '-l', '-c', command] : ['-l']
        const pty = this.loadPty().spawn(entry.shell, args, {
            name: 'xterm-256color',
            cols: entry.cols,
            rows: entry.rows,
            cwd: entry.info.cwd,
            env: terminalEnv(process.env, this.options.appVersion),
        })
        entry.pty = pty
        entry.info.exit = undefined
        entry.info.busy = !!command
        pty.onData(data => this.output(entry, data))
        pty.onExit(({ exitCode, signal }) => {
            if (entry.pty !== pty)
                return
            entry.pty = null
            this.flush(entry)
            const listeners = [...entry.exited]
            entry.exited.clear()
            listeners.forEach(f => f())
            if (!this.entries.has(entry.info.id))
                return
            // A shell the user exited closes, as in Terminal.app; a command's output stays to be read.
            if (!command) {
                this.drop(entry)
                return
            }
            entry.info.exit = { code: exitCode, ...(signal ? { signal } : {}) }
            entry.info.busy = false
            this.changed()
        })
    }

    private output(entry: Entry, data: string) {
        entry.seq++
        entry.headless.write(data)
        entry.pending += data
        if (entry.pending.length >= FLUSH_BYTES)
            this.flush(entry)
        else
            entry.flushTimer ??= setTimeout(() => this.flush(entry), FLUSH_MS)
    }

    private flush(entry: Entry) {
        if (entry.flushTimer)
            clearTimeout(entry.flushTimer)
        entry.flushTimer = null
        if (!entry.pending)
            return
        const data = entry.pending
        entry.pending = ''
        for (const sink of entry.sinks.values()) {
            if (sink.isDestroyed())
                entry.sinks.delete(sink.id)
            else
                sink.send(IPC.terminalData, entry.info.id, entry.seq, data)
        }
    }

    /** Waits until the headless terminal has parsed everything written so far. */
    private settled(entry: Entry): Promise<void> {
        return new Promise(resolve => entry.headless.write('', resolve))
    }

    /** Subscribes the window and returns the screen as of the last chunk it will not be sent. */
    attach(id: string, sink: TerminalSink): Promise<TerminalSnapshot> {
        const entry = this.need(id)
        // Everything output so far goes out now, so later messages hold only chunks after the snapshot.
        this.flush(entry)
        entry.sinks.set(sink.id, sink)
        const seq = entry.seq
        // The callback runs once the chunks before it are parsed and before any later one is.
        return new Promise(resolve => entry.headless.write('', () => resolve({
            data: entry.serializer.serialize({ scrollback: SCROLLBACK }),
            seq,
            cols: entry.headless.cols,
            rows: entry.headless.rows,
        })))
    }

    detach(id: string, sinkId: number) {
        this.entries.get(id)?.sinks.delete(sinkId)
    }

    /** A window went away: it gets nothing more. */
    detachAll(sinkId: number) {
        for (const entry of this.entries.values())
            entry.sinks.delete(sinkId)
    }

    write(id: string, data: string) {
        this.entries.get(id)?.pty?.write(data)
    }

    /** Several windows may show one terminal; the last one to resize sets its size, as in tmux. */
    resize(id: string, cols: number, rows: number) {
        const entry = this.entries.get(id)
        if (!entry)
            return
        cols = clampSize(cols, entry.cols)
        rows = clampSize(rows, entry.rows)
        if (cols === entry.cols && rows === entry.rows)
            return
        entry.cols = cols
        entry.rows = rows
        entry.headless.resize(cols, rows)
        try {
            entry.pty?.resize(cols, rows)
        }
        catch {}
    }

    /** Plain text of the last lines, once what was output so far is parsed. */
    async text(id: string, lines = 200): Promise<string> {
        const entry = this.need(id)
        await this.settled(entry)
        return plainText(entry.headless, Math.max(1, Math.min(SCROLLBACK, Math.floor(lines))))
    }

    /** Resolves when the terminal's process ends (at once if it has), or after `ms`. */
    waitExit(id: string, ms: number): Promise<boolean> {
        const entry = this.entries.get(id)
        if (!entry?.pty)
            return Promise.resolve(true)
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer)
                resolve(true)
            }
            const timer = setTimeout(() => {
                entry.exited.delete(done)
                resolve(false)
            }, ms)
            entry.exited.add(done)
        })
    }

    /** Ends the process and everything it started; the terminal stays (its output, a command's exit). */
    async stopProcess(id: string) {
        await this.stop(this.need(id))
    }

    /** Ends the process and everything it started; the terminal stays (its output, a command's exit). */
    private async stop(entry: Entry): Promise<void> {
        const pty = entry.pty
        if (!pty)
            return
        // Collected first: once the shell is gone its children belong to launchd and the tree is lost.
        const below = await descendants(pty.pid)
        const gone = new Promise<void>(resolve => entry.exited.add(resolve))
        // SIGHUP is what closing a terminal sends; shells pass it on to their jobs.
        try {
            pty.kill('SIGHUP')
        }
        catch {}
        below.forEach(pid => signal(pid, 'SIGTERM'))
        await Promise.race([gone, sleep(KILL_GRACE_MS)])
        for (const pid of [pty.pid, ...below]) {
            if (alive(pid))
                signal(pid, 'SIGKILL')
        }
        await Promise.race([gone, sleep(500)])
    }

    async close(id: string) {
        const entry = this.entries.get(id)
        if (!entry)
            return
        this.drop(entry)
        await this.stop(entry)
    }

    async restart(id: string) {
        const entry = this.need(id)
        if (!entry.info.command)
            throw new Error('only a command terminal can run again')
        await this.stop(entry)
        if (!this.entries.has(id))
            return
        this.output(entry, '\r\n\x1B[2m\u2500\u2500 restarted \u2500\u2500\x1B[0m\r\n')
        this.spawn(entry)
        this.changed()
    }

    /** Every terminal of folders no window shows any more. */
    closeOutside(open: ReadonlySet<string>): Promise<void> {
        return Promise.all([...this.entries.values()].filter(e => !open.has(e.info.cwd)).map(e => this.close(e.info.id))).then(() => {})
    }

    /** Quit: everything ends, within the kill grace. */
    async closeAll() {
        await Promise.all([...this.entries.keys()].map(id => this.close(id)))
    }

    /** Terminals of these folders with something running in them (the close-window prompt). */
    busyIn(cwds: readonly string[]): number {
        return [...this.entries.values()].filter(e => e.info.busy && cwds.includes(e.info.cwd)).length
    }

    private drop(entry: Entry) {
        if (!this.entries.delete(entry.info.id))
            return
        if (entry.flushTimer)
            clearTimeout(entry.flushTimer)
        entry.sinks.clear()
        // Disposed after the parser is done with anything still queued.
        void this.settled(entry).then(() => entry.headless.dispose())
        if (!this.entries.size && this.poll) {
            clearInterval(this.poll)
            this.poll = null
        }
        this.changed()
    }

    private need(id: string): Entry {
        const entry = this.entries.get(id)
        if (!entry)
            throw new Error('no such terminal')
        return entry
    }

    /** The foreground program names the tab and says whether anything runs. */
    private pollTitles() {
        let changed = false
        for (const entry of this.entries.values()) {
            if (!entry.pty || entry.info.command)
                continue
            let fg = ''
            try {
                fg = entry.pty.process
            }
            catch {}
            const shellName = path.basename(entry.shell)
            const busy = !!fg && fg !== shellName && fg !== `-${shellName}`
            const title = entry.label ?? (busy ? fg : shellName)
            if (busy !== entry.info.busy || title !== entry.info.title) {
                entry.info.busy = busy
                entry.info.title = title
                changed = true
            }
        }
        if (changed)
            this.changed()
    }

    /** Coalesced: several changes in one tick make one list update. */
    private changed() {
        this.changeTimer ??= setTimeout(() => {
            this.changeTimer = null
            this.options.onChange(this.list())
        }, 0)
    }
}

function clampSize(value: unknown, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 2 ? Math.min(1000, Math.floor(value)) : fallback
}

/** `bun run dev` → "bun run dev"; a long command line is cut for the tab. */
function commandTitle(command: string) {
    const line = command.split('\n')[0].trim()
    return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
