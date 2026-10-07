// pi's TUI in a detached tmux session, for tests of the app next to a terminal pi (pi-cc-tui's
// presence and bridge). Only pi-cc-tui extensions named in `extensions` load.
import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { piCommand } from '../electron/pi-env'
import { findPi } from './harness'

const run = promisify(execFile)
export const CC_EXTENSIONS = path.resolve(import.meta.dirname, '../packages/pi-cc-tui/extensions')

export const hasTmux = (() => {
    try {
        execFileSync('tmux', ['-V'])
        return true
    }
    catch {
        return false
    }
})()

const quote = (s: string) => `'${s.replaceAll('\'', `'\\''`)}'`

export interface Terminal {
    /** The visible screen. */
    pane: () => Promise<string>
    /** tmux send-keys arguments; `type` sends literal text, then Enter. */
    keys: (...keys: string[]) => Promise<void>
    type: (text: string) => Promise<void>
    kill: () => Promise<void>
}

export async function startTerminalPi(options: { agentDir: string, cwd: string, extensions: string[], args?: string[], env?: Record<string, string> }): Promise<Terminal> {
    const pi = await findPi()
    if (!pi)
        throw new Error('pi not found')
    const extensions = options.extensions.flatMap(e => ['-e', path.join(CC_EXTENSIONS, e)])
    const command = piCommand(pi, ['--no-extensions', '--no-mcp', ...extensions, ...options.args ?? []])
    const vars = { PI_CODING_AGENT_DIR: options.agentDir, ...options.env }
    const line = ['env', ...Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}`), quote(command.file), ...command.args.map(quote)].join(' ')
    const session = `pi-term-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await run('tmux', ['new-session', '-d', '-s', session, '-x', '140', '-y', '40', '-c', options.cwd, line])
    const keys = async (...keys: string[]) => void await run('tmux', ['send-keys', '-t', session, ...keys])
    return {
        pane: async () => (await run('tmux', ['capture-pane', '-p', '-t', session])).stdout,
        keys,
        type: async (text) => {
            await keys('-l', text)
            await keys('Enter')
        },
        kill: async () => void await run('tmux', ['kill-session', '-t', session]).catch(() => {}),
    }
}
