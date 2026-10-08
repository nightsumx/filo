// Windows: no login shell (the app inherits the user's environment from Explorer), programs are found
// by extension (PATHEXT), npm installs commands as .cmd shims that Node will not spawn without a shell,
// terminals run PowerShell over ConPTY, local servers are named pipes and process trees end through
// taskkill. Archives go through the bsdtar Windows ships (System32\tar.exe), which reads zip too.
import type { Command, Platform, ShellEnv } from './types'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import nodePath from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

// Windows paths, also when the tests run this file elsewhere.
const path = nodePath.win32

const execFileAsync = promisify(execFile)

const system32 = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')

/** Extensions tried for a bare name, in PATHEXT's order (the ones a program can have). */
function extensions(): string[] {
    const listed = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim().toLowerCase()).filter(Boolean)
    return listed.filter(e => ['.com', '.exe', '.bat', '.cmd'].includes(e))
}

const isFile = (file: string) => {
    try {
        return statSync(file).isFile()
    }
    catch {
        return false
    }
}

function findSync(name: string, dirs: readonly string[]): string | undefined {
    const names = path.extname(name) ? [name] : extensions().map(e => name + e)
    for (const dir of dirs) {
        if (!dir)
            continue
        for (const n of names) {
            const file = path.join(dir, n)
            if (isFile(file))
                return file
        }
    }
    return undefined
}

/** A batch file: `set` for the variables (local to it), then the command with its arguments. */
function batchLauncher(name: string, env: Record<string, string>, argv: readonly string[]) {
    // In a batch file % starts a variable; %% is a literal one.
    const arg = (s: string) => `"${s.replaceAll('%', '%%')}"`
    const lines = [
        '@echo off',
        ':: The app\'s Electron as node, for agents it installed (electron/acp/node.ts).',
        'setlocal',
        ...Object.entries(env).map(([k, v]) => `set "${k}=${v.replaceAll('%', '%%')}"`),
        `${argv.map(arg).join(' ')} %*`,
    ]
    return { file: `${name}.cmd`, text: `${lines.join('\r\n')}\r\n` }
}

const pathDirs = () => (process.env.PATH ?? '').split(path.delimiter)

/**
 * The script an npm .cmd shim (cmd-shim) runs: `"%dp0%\node_modules\pkg\bin\cli.js" %*` (`%~dp0`
 * in older ones). Undefined for any other batch file.
 */
export function shimScript(cmdFile: string, text: string): string | undefined {
    const match = text.match(/"%~?dp0%?\\([^"]+\.[cm]?js)"\s+%\*/i)
    return match ? path.join(path.dirname(cmdFile), match[1]) : undefined
}

function readShim(file: string): string | undefined {
    try {
        return shimScript(file, readFileSync(file, 'utf8'))
    }
    catch {
        return undefined
    }
}

/** cmd.exe's quoting for one argument of `cmd /d /s /c "…"`. */
const cmdQuote = (arg: string) => /^[\w\-.\\/:=@]+$/.test(arg) ? arg : `"${arg.replace(/(["^&|<>%!])/g, '^$1')}"`

function command(file: string, args: readonly string[]): Command {
    if (!/\.(cmd|bat)$/i.test(file))
        return { file, args: [...args] }
    const script = readShim(file)
    if (script) {
        // The shim prefers a node.exe next to it, as cmd-shim does.
        const local = path.join(path.dirname(file), 'node.exe')
        const node = isFile(local) ? local : findSync('node', pathDirs()) ?? 'node.exe'
        return { file: node, args: [script, ...args] }
    }
    // Any other batch file runs through cmd.exe, as Windows would run it.
    return { file: process.env.ComSpec || path.join(system32(), 'cmd.exe'), args: ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`] }
}

async function shellEnv(): Promise<ShellEnv> {
    const dirs = pathDirs()
    const node = findSync('node', dirs) ?? ''
    const pi = findSync('pi', dirs) ?? ''
    // pi from npm is pi.cmd; the app runs its script with node, as on macOS.
    const script = pi && /\.(cmd|bat)$/i.test(pi) ? readShim(pi) ?? '' : pi
    return { node, pi: script }
}

function userShell(): string {
    return findSync('pwsh', pathDirs())
        ?? [path.join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe')].find(isFile)
        ?? process.env.ComSpec
        ?? path.join(system32(), 'cmd.exe')
}

function shellArgs(shell: string, command?: string): string[] {
    if (/^cmd(\.exe)?$/i.test(path.basename(shell)))
        return command ? ['/d', '/s', '/c', command] : []
    return command ? ['-NoLogo', '-Command', command] : ['-NoLogo']
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function taskkill(pid: number) {
    await execFileAsync(path.join(system32(), 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: 10_000, windowsHide: true }).catch(() => {})
}

export const win32: Platform = {
    id: 'win32',
    target: `win32-${process.arch}`,

    shellEnv,
    userShell,
    shellArgs,
    findIn: async (name, dirs) => findSync(name, dirs),
    command,
    launcher: batchLauncher,
    // Windows environment names are case-insensitive: one key, or the child sees two PATHs.
    withPath: (env, value) => {
        const out: Record<string, string> = {}
        for (const [key, v] of Object.entries(env)) {
            if (key.toUpperCase() !== 'PATH')
                out[key] = v
        }
        out.PATH = value
        return out
    },

    // Console programs get no signal to end on; the tree is ended at once, the shell first knowing it.
    stopTree: async (pid, kill, exited, graceMs) => {
        await taskkill(pid)
        try {
            kill()
        }
        catch {}
        await Promise.race([exited, sleep(graceMs)])
    },

    // Named pipes live in one machine-wide namespace: the folder's hash keeps users and agent dirs apart.
    ipcPath: (dir, name) => `\\\\.\\pipe\\filo-${createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 16)}-${name}`,
    // A pipe's default ACL lets only this user (and admins, SYSTEM) open it for writing; servers that
    // send anything before a request also check a token (protocol.ts).
    restrict: () => {},
    clearIpc: () => {},

    unpack: (archive, dir, run) => run({ file: path.join(system32(), 'tar.exe'), args: ['-xf', archive, '-C', dir] }),
    archiveEntries: async (file) => {
        const { stdout } = await execFileAsync(path.join(system32(), 'tar.exe'), ['-tf', file], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
        return stdout.split(/\r?\n/).filter(Boolean)
    },
    preparePty: () => {},
}
