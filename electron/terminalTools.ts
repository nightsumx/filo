// The agent's side of the Terminal tool window: pi's terminal capability (packages/capabilities/
// extensions/terminal.ts) connects to this unix socket to run commands in app terminals, read their
// output and stop them. The user sees the same terminals, so a dev server the agent started is one
// they can watch, type into or close, and output the user produced is something the agent can read.
//
// Only pi processes the app starts get the socket path and token (ENV.terminals / terminalsToken).
import type { TerminalCall, TerminalRequest, TerminalResponse, TerminalSummary } from '@shared/capabilities'
import type { TerminalInfo } from '@shared/ipc'
import { ENV } from '@shared/capabilities'
import type { Terminals } from './terminals'
import path from 'node:path'
import { projectOf, ToolSocket } from './toolSocket'

const MAX_OUTPUT_CHARS = 12_000
const POLL_MS = 200
const MAX_TIMEOUT_MS = 10 * 60_000
const RUN_LINES = 60
const READ_LINES = 80

export function summary(info: TerminalInfo): TerminalSummary {
    return {
        id: info.id,
        title: info.title,
        ...(info.command ? { command: info.command } : {}),
        // Setup terminals never reach the agent (they are listed for no project).
        by: info.by === 'agent' ? 'agent' : 'user',
        status: info.exit ? 'exited' : info.busy ? 'running' : 'idle',
        ...(info.exit ? { exitCode: info.exit.code } : {}),
    }
}

const count = (text: string, needle: string) => needle ? text.split(needle).length - 1 : 0

/** The tail, cut at a line start, so a chatty process does not flood the model's context. */
function tail(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS)
        return text
    const cut = text.slice(-MAX_OUTPUT_CHARS)
    const nl = cut.indexOf('\n')
    return `[… earlier output cut]\n${nl === -1 ? cut : cut.slice(nl + 1)}`
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const timeout = (ms: unknown, fallback: number) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.min(MAX_TIMEOUT_MS, ms) : fallback

export class TerminalTools {
    private socket: ToolSocket<TerminalRequest, TerminalResponse>

    /** `projects`: folders the windows show; a request's cwd is matched to one of them. */
    constructor(private terminals: Terminals, readonly socketPath: string, private projects: () => Iterable<string> = () => []) {
        this.socket = new ToolSocket(socketPath, request => this.handle(request), { socket: ENV.terminals, token: ENV.terminalsToken })
    }

    get token() {
        return this.socket.token
    }

    start() {
        return this.socket.start()
    }

    /** What a pi the app starts gets, once the socket listens. */
    env() {
        return this.socket.env()
    }

    stop() {
        this.socket.stop()
    }

    async handle(request: TerminalCall): Promise<TerminalResponse> {
        if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd))
            throw new Error('cwd must be an absolute path')
        const cwd = projectOf(request.cwd, this.projects())
        const ofProject = (id: unknown) => {
            const info = typeof id === 'string' ? this.terminals.get(id) : undefined
            if (!info || info.cwd !== cwd || info.by === 'setup')
                throw new Error(`no terminal ${String(id)} in this project; call terminal_read without an id to list them`)
            return info
        }

        if (request.method === 'run') {
            const command = typeof request.command === 'string' ? request.command.trim() : ''
            if (!command || command.length > 10_000)
                throw new Error('command is required')
            const waitFor = typeof request.waitFor === 'string' ? request.waitFor : ''
            // The same command again (restarting a dev server) reuses its terminal rather than piling up tabs.
            const same = this.terminals.list().find(t => t.by === 'agent' && t.cwd === cwd && t.command === command)
            let id: string
            let baseline = 0
            if (same) {
                baseline = count(await this.terminals.text(same.id, 10_000), waitFor)
                await this.terminals.restart(same.id)
                id = same.id
            }
            else {
                id = this.terminals.create({ cwd, command, label: typeof request.label === 'string' ? request.label.slice(0, 60) : undefined }, 'agent').id
            }
            const matched = await this.wait(id, waitFor, baseline, timeout(request.timeoutMs, 10_000))
            return { ok: true, terminal: summary(this.terminals.get(id) ?? ofProject(id)), output: tail(await this.terminals.text(id, RUN_LINES)), restarted: !!same, ...(waitFor ? { matched } : {}) }
        }

        if (request.method === 'read') {
            if (request.id === undefined)
                return { ok: true, terminals: this.terminals.list().filter(t => t.cwd === cwd && t.by !== 'setup').map(summary) }
            const info = ofProject(request.id)
            const waitFor = typeof request.waitFor === 'string' ? request.waitFor : ''
            let matched: boolean | undefined
            if (waitFor) {
                // Output from here on: what is on screen already does not count.
                const baseline = count(await this.terminals.text(info.id, 10_000), waitFor)
                matched = await this.wait(info.id, waitFor, baseline, timeout(request.timeoutMs, 30_000))
            }
            const lines = typeof request.lines === 'number' && request.lines > 0 ? Math.min(400, Math.floor(request.lines)) : READ_LINES
            return { ok: true, terminal: summary(this.terminals.get(info.id) ?? info), output: tail(await this.terminals.text(info.id, lines)), ...(waitFor ? { matched } : {}) }
        }

        if (request.method === 'stop') {
            const info = ofProject(request.id)
            // The user's own shells are theirs to close; the agent stops what it started.
            if (info.by !== 'agent')
                throw new Error('that terminal belongs to the user; only terminals started with terminal_run can be stopped')
            await this.terminals.stopProcess(info.id)
            return { ok: true, terminal: summary(this.terminals.get(info.id) ?? info), output: tail(await this.terminals.text(info.id, 20)) }
        }

        throw new Error('unknown method')
    }

    /**
     * Until `waitFor` shows up more often than `baseline` times, the process ends, or the time is up.
     * Returns whether the text showed up.
     */
    private async wait(id: string, waitFor: string, baseline: number, ms: number): Promise<boolean> {
        const end = Date.now() + ms
        for (;;) {
            const info = this.terminals.get(id)
            if (!info)
                return false
            if (waitFor && count(await this.terminals.text(id, 10_000), waitFor) > baseline)
                return true
            if (info.exit || Date.now() >= end)
                return false
            await Promise.race([sleep(Math.min(POLL_MS, Math.max(0, end - Date.now()))), this.terminals.waitExit(id, POLL_MS)])
        }
    }
}
