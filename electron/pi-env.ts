import type { PiEnv, PiEnvResult } from '@shared/ipc'
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { tr } from './i18n'

const execFileAsync = promisify(execFile)

/**
 * Which pi the app runs. The user's own pi always wins: it is what they run in the terminal, at the
 * version they chose. Without one (the app installed on its own, no Node), the pi shipped in the app
 * runs on the app's Electron as node. Both read and write the same ~/.pi/agent (sign-ins, models,
 * settings, sessions), so installing pi later changes nothing but the program.
 *
 * GUI apps on macOS do not inherit the user's shell PATH, and version managers like fnm put
 * `node`/`pi` behind per-shell symlinks that disappear later. So: ask a login shell once,
 * resolve the real files immediately, and remember the PATH that shell had.
 *
 * PI_GUI_PI / PI_GUI_NODE pick a pi explicitly; PI_GUI_PI=bundled forces the shipped one.
 */
let cached: Promise<PiEnvResult> | undefined
let shellPath = process.env.PATH ?? ''

/**
 * The shipped pi's CLI and the launcher that starts it, set by main at startup. `runtime` is the
 * Electron binary that runs it, by default this process's (tests pass the electron package's).
 */
interface BundledPi { cli: string, launcher: string, runtime?: string }
let bundledPi: BundledPi | undefined

export function setBundledPi(paths: BundledPi | undefined) {
    bundledPi = paths
    cached = undefined
}

export function resolvePiEnv(): Promise<PiEnvResult> {
    cached ??= resolveUncached().catch(error => ({ ok: false as const, error: String(error?.message ?? error) }))
    return cached
}

export function resetPiEnv() {
    cached = undefined
}

/**
 * Environment for spawned pi processes: login-shell PATH with the real node bin dir first. The
 * bundled pi gets the shell's PATH as it is, and runs Electron as node (its launcher drops the flag
 * again for what pi starts).
 */
export function piSpawnEnv(env: PiEnv): Record<string, string> {
    const base = { ...process.env as Record<string, string> }
    delete base.ELECTRON_RUN_AS_NODE
    if (env.bundled)
        return { ...base, PATH: shellPath, ELECTRON_RUN_AS_NODE: '1' }
    const nodeBin = path.dirname(env.nodePath)
    const parts = [nodeBin, ...shellPath.split(':').filter(p => p && p !== nodeBin)]
    return { ...base, PATH: parts.join(':') }
}

/** pi's bin is usually a JS file run by node; a compiled binary is spawned directly. */
export function piCommand(env: PiEnv, args: string[]): { file: string, args: string[] } {
    if (env.bundled)
        return { file: env.nodePath, args: [env.bundled.launcher, env.piPath, ...args] }
    return /\.[cm]?js$/.test(env.piPath)
        ? { file: env.nodePath, args: [env.piPath, ...args] }
        : { file: env.piPath, args }
}

async function resolveUncached(): Promise<PiEnvResult> {
    const forced = process.env.PI_GUI_PI === 'bundled'
    const { found, ...local } = forced ? { found: false, ok: false as const, error: '' } : await resolveLocal()
    if (local.ok)
        return local
    const shipped = await resolveBundled()
    if (shipped?.ok) {
        if (found)
            shipped.env.note = local.error
        return shipped
    }
    // A pi of the user's that fails says more than the shipped one failing too.
    if (found || !shipped)
        return local.error ? local : { ok: false, error: tr('这个版本没有附带 pi。', 'This build does not include pi.') }
    return shipped
}

/** The pi shipped in the app, run by the app's Electron as node; undefined when there is none. */
async function resolveBundled(): Promise<PiEnvResult | undefined> {
    if (!bundledPi || !existsSync(bundledPi.cli) || !existsSync(bundledPi.launcher))
        return undefined
    if (!process.env.PI_GUI_PI)
        await loadShellPath()
    return checkVersion({ nodePath: bundledPi.runtime ?? process.execPath, piPath: bundledPi.cli, version: '', bundled: { launcher: bundledPi.launcher } })
}

/** `pi --version` through the same command and environment the threads use. */
async function checkVersion(env: PiEnv): Promise<PiEnvResult> {
    const { file, args } = piCommand(env, ['--version'])
    try {
        const { stdout } = await execFileAsync(file, args, { env: piSpawnEnv(env), timeout: 15_000 })
        env.version = stdout.trim()
    }
    catch (error: any) {
        return { ok: false, error: `${tr('pi 无法启动：', 'pi failed to start: ')}${error?.stderr || error?.message || error}` }
    }
    return { ok: true, env }
}

let shellLoaded = false

/** The login shell's PATH, for the bundled pi when no local one was looked up. */
async function loadShellPath() {
    if (shellLoaded)
        return
    shellLoaded = true
    const fromShell = await queryLoginShell().catch(() => undefined)
    if (fromShell?.path)
        shellPath = fromShell.path
}

/** The user's own pi; `found` tells a pi that failed to start from no pi at all. */
async function resolveLocal(): Promise<PiEnvResult & { found?: boolean }> {
    let nodePath = process.env.PI_GUI_NODE ?? ''
    let piPath = process.env.PI_GUI_PI ?? ''

    if (!nodePath || !piPath) {
        shellLoaded = true
        const fromShell = await queryLoginShell().catch(() => ({ node: '', pi: '', path: '' }))
        nodePath ||= fromShell.node
        piPath ||= fromShell.pi
        if (fromShell.path)
            shellPath = fromShell.path
    }

    if (!piPath || !existsSync(piPath))
        return { ok: false, error: tr('找不到 pi 命令。请先安装：npm install -g @earendil-works/pi-coding-agent，或设置环境变量 PI_GUI_PI。', 'pi command not found. Install it with npm install -g @earendil-works/pi-coding-agent, or set PI_GUI_PI.') }
    if (/\.[cm]?js$/.test(piPath) && (!nodePath || !existsSync(nodePath)))
        return { ok: false, found: true, error: tr('找不到 node。pi 需要 Node.js 22.19 以上，或设置环境变量 PI_GUI_NODE。', 'node not found. pi needs Node.js 22.19 or later; or set PI_GUI_NODE.') }
    return { ...await checkVersion({ nodePath, piPath, version: '' }), found: true }
}

async function queryLoginShell(): Promise<{ node: string, pi: string, path: string }> {
    const shell = process.env.SHELL || '/bin/zsh'
    // Markers make the output robust against banners printed by interactive shell configs.
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
    return { node: real(read('NODE')), pi: real(read('PI')), path: read('PATH') }
}
