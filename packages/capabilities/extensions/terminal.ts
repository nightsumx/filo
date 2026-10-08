// terminal: long-running processes (dev servers, watchers, emulators) in the desktop app's Terminal
// tool window instead of the bash tool, which waits for a command to end. The user sees the same
// terminals: they can watch a server the agent started, type into it or close it, and the agent can
// read what the user's own terminals print (a stack trace in the dev server).
//
// Talks to the app over the unix socket it names in PI_KIT_TERMINALS (protocol.ts, TerminalRequest);
// without the app (pi-cc-tui in a terminal) the tools are not registered.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { TerminalCall, TerminalDetails, TerminalResponse, TerminalSummary } from '../protocol'
import net from 'node:net'
import { Type } from 'typebox'

const SOCKET_ENV = 'PI_KIT_TERMINALS'
const TOKEN_ENV = 'PI_KIT_TERMINALS_TOKEN'
/** Read-only helper processes (review, autopilot) may look at terminals but not start or stop them. */
const READ_ONLY_ENVS = ['PI_KIT_REVIEWER', 'PI_KIT_AUTOPILOT_SUPERVISOR', 'PI_KIT_AUTOPILOT_LEARNER']

/** One request per connection; an aborted tool call drops the connection (the app's terminal lives on). */
function request(body: TerminalCall, signal?: AbortSignal): Promise<TerminalResponse> {
    const socketPath = process.env[SOCKET_ENV]!
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath)
        let buffer = ''
        const abort = () => {
            socket.destroy()
            reject(new Error('aborted'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        socket.setEncoding('utf8')
        socket.on('connect', () => socket.write(`${JSON.stringify({ ...body, token: process.env[TOKEN_ENV] ?? '' })}\n`))
        socket.on('data', (chunk: string) => {
            buffer += chunk
        })
        socket.on('end', () => {
            signal?.removeEventListener('abort', abort)
            try {
                resolve(JSON.parse(buffer))
            }
            catch {
                reject(new Error('the app sent no answer'))
            }
        })
        socket.on('error', (error) => {
            signal?.removeEventListener('abort', abort)
            reject(new Error(`the app's terminals are not reachable (${error.message})`))
        })
    })
}

function describe(t: TerminalSummary): string {
    const state = t.status === 'exited' ? `exited with code ${t.exitCode}` : t.status
    return `${t.id}  ${t.command ? JSON.stringify(t.command) : t.title}  [${state}${t.by === 'user' ? ', opened by the user' : ''}]`
}

type Result = { content: { type: 'text', text: string }[], details: TerminalDetails, isError?: boolean }

function result(response: TerminalResponse, head: (r: Extract<TerminalResponse, { ok: true }>) => string): Result {
    if (!response.ok)
        return { content: [{ type: 'text', text: response.error }], details: { kind: 'terminal' }, isError: true }
    const parts = [head(response)]
    if (response.output !== undefined)
        parts.push(response.output.trim() ? `Output (last lines):\n${response.output}` : '(no output yet)')
    return { content: [{ type: 'text', text: parts.join('\n\n') }], details: { kind: 'terminal', ...(response.terminal ? { terminal: response.terminal } : {}) } }
}

const seconds = (s: number | undefined) => (s === undefined ? undefined : Math.max(0, s) * 1000)

export default function (pi: ExtensionAPI) {
    if (!process.env[SOCKET_ENV])
        return
    const readOnly = READ_ONLY_ENVS.some(name => process.env[name])

    if (!readOnly) {
        pi.registerTool({
            name: 'terminal_run',
            label: 'Terminal Run',
            description: 'Start a long-running command (dev server, watcher, emulator) in a terminal of the user\'s app, in the project folder. Returns once wait_for appears in its output, it exits, or timeout passes; it keeps running after that. Running the same command again restarts it in the same terminal.',
            promptSnippet: 'Run dev servers and other long-running processes in an app terminal the user can see',
            promptGuidelines: [
                'Use terminal_run, not bash, for processes that keep running (dev servers, watchers, `tail -f`); bash is for commands that finish.',
                'Check terminal_read without an id before starting a server: the user may already run one.',
            ],
            parameters: Type.Object({
                command: Type.String({ description: 'Shell command, run in the user\'s login shell' }),
                label: Type.Optional(Type.String({ description: 'Short tab name, e.g. "web dev"' })),
                wait_for: Type.Optional(Type.String({ description: 'Text in the output that means it is ready, e.g. "ready in" or "Listening on"' })),
                timeout: Type.Optional(Type.Number({ description: 'Seconds to wait (default 10, max 600)' })),
            }),
            async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                const response = await request({ method: 'run', cwd: ctx.cwd, command: params.command, label: params.label, waitFor: params.wait_for, timeoutMs: seconds(params.timeout) }, signal)
                return result(response, (r) => {
                    const t = r.terminal!
                    const ready = r.matched === undefined ? '' : r.matched ? ` "${params.wait_for}" appeared.` : ` "${params.wait_for}" did not appear yet.`
                    const state = t.status === 'exited' ? `It exited with code ${t.exitCode}.` : `It is running.${ready}`
                    return `${r.restarted ? 'Restarted' : 'Started'} in terminal ${t.id}. ${state}`
                })
            },
        })

        pi.registerTool({
            name: 'terminal_stop',
            label: 'Terminal Stop',
            description: 'Stop a process started with terminal_run, and everything it started. Its terminal stays open with the output.',
            parameters: Type.Object({ id: Type.String({ description: 'Terminal id' }) }),
            async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                const response = await request({ method: 'stop', cwd: ctx.cwd, id: params.id }, signal)
                return result(response, r => `Stopped: ${describe(r.terminal!)}`)
            },
        })
    }

    pi.registerTool({
        name: 'terminal_read',
        label: 'Terminal Read',
        description: 'Without id: list the app\'s terminals in this project (the user\'s and yours). With id: its recent output as plain text; with wait_for, first wait until that text is printed again.',
        parameters: Type.Object({
            id: Type.Optional(Type.String({ description: 'Terminal id' })),
            lines: Type.Optional(Type.Number({ description: 'Lines from the end (default 80, max 400)' })),
            wait_for: Type.Optional(Type.String({ description: 'Wait until this text appears in new output' })),
            timeout: Type.Optional(Type.Number({ description: 'Seconds to wait for wait_for (default 30, max 600)' })),
        }),
        annotations: { readOnlyHint: true },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const response = await request({ method: 'read', cwd: ctx.cwd, id: params.id, lines: params.lines, waitFor: params.wait_for, timeoutMs: seconds(params.timeout) }, signal)
            return result(response, (r) => {
                if (r.terminals)
                    return r.terminals.length ? `Terminals in this project:\n${r.terminals.map(describe).join('\n')}` : 'No terminals open in this project.'
                const waited = r.matched === undefined ? '' : r.matched ? `\n"${params.wait_for}" appeared.` : `\n"${params.wait_for}" did not appear before the timeout.`
                return `${describe(r.terminal!)}${waited}`
            })
        },
    })
}
