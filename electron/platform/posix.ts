// What macOS and Linux share: a login shell knows the user's PATH, programs are files with the
// executable bit, processes form a tree `ps` lists and signals end, local servers are unix sockets.
import type { Command, Launcher, Platform, ShellEnv } from './types'
import { execFile } from 'node:child_process'
import { accessSync, chmodSync, constants, realpathSync, rmSync, statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * GUI apps do not inherit the user's shell PATH, and version managers like fnm put `node`/`pi`
 * behind per-shell symlinks that disappear later. So: ask a login shell once and resolve the real
 * files immediately. Markers keep the output readable past banners an interactive config prints.
 */
export async function loginShellEnv(fallbackShell: string): Promise<ShellEnv> {
    const shell = process.env.SHELL || fallbackShell
    const script = [
        'printf "\\n__NODE__=%s\\n" "$(command -v node)"',
        'printf "__PI__=%s\\n" "$(command -v pi)"',
        'printf "__PATH__=%s\\n" "$PATH"',
    ].join('; ')
    const { stdout } = await execFileAsync(shell, ['-ilc', script], { timeout: 15_000 })
    const read = (key: string) => stdout.match(new RegExp(`^__${key}__=(.*)$`, 'm'))?.[1]?.trim() ?? ''
    const real = (p: string) => {
        try {
            return p ? realpathSync(p) : ''
        }
        catch {
            return p
        }
    }
    return { node: real(read('NODE')), pi: real(read('PI')), path: read('PATH') || undefined }
}

/** The user's shell; GUI apps usually have SHELL, else the account's. */
export function posixShell(fallback: string): string {
    const shell = process.env.SHELL || os.userInfo().shell
    return shell && path.isAbsolute(shell) ? shell : fallback
}

/**
 * A login shell, so PATH and the rest come from the user's profile, as in a terminal app. A command
 * runs in an interactive one too: version managers (fnm, nvm) are set up in .zshrc / .bashrc.
 */
export const posixShellArgs = (_shell: string, command?: string) => command ? ['-i', '-l', '-c', command] : ['-l']

export async function findExecutable(name: string, dirs: readonly string[]): Promise<string | undefined> {
    for (const dir of dirs) {
        if (!dir)
            continue
        const file = path.join(dir, name)
        try {
            await access(file, constants.X_OK)
            return file
        }
        catch {}
    }
    return undefined
}

export const directCommand = (file: string, args: readonly string[]): Command => ({ file, args: [...args] })

/** Every process below `pid`, deepest last (from one `ps` listing). */
export async function descendants(pid: number, ps = '/bin/ps'): Promise<number[]> {
    let stdout = ''
    try {
        stdout = (await execFileAsync(ps, ['-axo', 'pid=,ppid='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function posixStopTree(ps: string): Platform['stopTree'] {
    return async (pid, kill, exited, graceMs) => {
        // Collected first: once the shell is gone its children belong to init and the tree is lost.
        const below = await descendants(pid, ps)
        // SIGHUP is what closing a terminal sends; shells pass it on to their jobs.
        try {
            kill('SIGHUP')
        }
        catch {}
        below.forEach(p => signal(p, 'SIGTERM'))
        await Promise.race([exited, sleep(graceMs)])
        for (const p of [pid, ...below]) {
            if (alive(p))
                signal(p, 'SIGKILL')
        }
        await Promise.race([exited, sleep(500)])
    }
}

const shQuote = (s: string) => `'${s.replaceAll('\'', '\'\\\'\'')}'`

/** A /bin/sh script; the caller makes it executable. */
export function shLauncher(name: string, env: Record<string, string>, argv: readonly string[]): Launcher {
    const vars = Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)} `).join('')
    return { file: name, text: `#!/bin/sh\n# The app's Electron as node, for agents it installed (electron/acp/node.ts).\n${vars}exec ${argv.map(shQuote).join(' ')} "$@"\n` }
}

/** Socket paths are capped (104 bytes on macOS, 108 on Linux); a long home folder falls back to the temp folder. */
export function socketPath(dir: string, name: string): string {
    const preferred = path.join(dir, name)
    return Buffer.byteLength(preferred) < 100 ? preferred : path.join(os.tmpdir(), name)
}

export const restrictSocket = (file: string) => chmodSync(file, 0o600)

/** A socket file left by a crashed run would make listen fail with EADDRINUSE. */
export function clearSocket(file: string) {
    if (statSync(file, { throwIfNoEntry: false })?.isSocket())
        rmSync(file, { force: true })
}

/**
 * node-pty 1.1.0 ships spawn-helper without its executable bit; every spawn fails with
 * "posix_spawnp failed" until it has one. Packaged builds get it at build time.
 */
export function chmodPtyHelper(ptyDir: string, target: string) {
    const helper = path.join(ptyDir, 'prebuilds', target, 'spawn-helper')
    try {
        accessSync(helper, constants.X_OK)
    }
    catch {
        try {
            chmodSync(helper, statSync(helper).mode | 0o111)
        }
        catch {}
    }
}
