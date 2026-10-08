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
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { platform } from './platform'

const MAX_REQUEST = 64 * 1024
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
        by: info.by,
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

function realpath(dir: string): string {
    try {
        return realpathSync(dir)
    }
    catch {
        return dir
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const timeout = (ms: unknown, fallback: number) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.min(MAX_TIMEOUT_MS, ms) : fallback

export class TerminalTools {
    readonly token = randomBytes(24).toString('hex')
    private server: net.Server | null = null

    /** `projects`: folders the windows show; a request's cwd is matched to one of them. */
    constructor(private terminals: Terminals, readonly socketPath: string, private projects: () => Iterable<string> = () => []) {}

    /**
     * pi reports its cwd as the OS resolved it (/private/tmp/x for /tmp/x); terminals are filed under
     * the project folder as the windows know it, so a request is mapped back to that.
     */
    private projectOf(cwd: string): string {
        const real = realpath(cwd)
        for (const project of this.projects()) {
            if (project === cwd || realpath(project) === real)
                return project
        }
        return cwd
    }

    async start() {
        platform.clearIpc(this.socketPath)
        const server = net.createServer(socket => this.connection(socket))
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(this.socketPath, () => {
                server.off('error', reject)
                resolve()
            })
        })
        platform.restrict(this.socketPath)
        this.server = server
    }

    /** What a pi the app starts gets, once the socket listens. */
    env(): Record<string, string> {
        return this.server ? { [ENV.terminals]: this.socketPath, [ENV.terminalsToken]: this.token } : {}
    }

    stop() {
        if (!this.server)
            return
        this.server.close()
        this.server = null
        platform.clearIpc(this.socketPath)
    }

    private connection(socket: net.Socket) {
        let buffer = ''
        socket.setEncoding('utf8')
        socket.on('error', () => {})
        socket.on('data', (chunk: string) => {
            buffer += chunk
            if (buffer.length > MAX_REQUEST) {
                socket.destroy()
                return
            }
            const nl = buffer.indexOf('\n')
            if (nl === -1)
                return
            const line = buffer.slice(0, nl)
            socket.removeAllListeners('data')
            void this.answer(line).then(response => socket.end(`${JSON.stringify(response)}\n`))
        })
    }

    private async answer(line: string): Promise<TerminalResponse> {
        let request: TerminalRequest
        try {
            request = JSON.parse(line)
        }
        catch {
            return { ok: false, error: 'bad request' }
        }
        const token = Buffer.from(typeof request?.token === 'string' ? request.token : '')
        const expected = Buffer.from(this.token)
        if (token.length !== expected.length || !timingSafeEqual(token, expected))
            return { ok: false, error: 'not authorized' }
        try {
            return await this.handle(request)
        }
        catch (error: any) {
            return { ok: false, error: String(error?.message ?? error) }
        }
    }

    async handle(request: TerminalCall): Promise<TerminalResponse> {
        if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd))
            throw new Error('cwd must be an absolute path')
        const cwd = this.projectOf(request.cwd)
        const ofProject = (id: unknown) => {
            const info = typeof id === 'string' ? this.terminals.get(id) : undefined
            if (!info || info.cwd !== cwd)
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
                return { ok: true, terminals: this.terminals.list().filter(t => t.cwd === cwd).map(summary) }
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
