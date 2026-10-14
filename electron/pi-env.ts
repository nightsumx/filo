import type { PiEnv, PiEnvResult } from '@shared/ipc'
import type { Command } from './platform'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { tr } from './i18n'
import { platform } from './platform'

const execFileAsync = promisify(execFile)

/**
 * Which pi the app runs: the user's own, the one they run in the terminal, at the version they chose.
 * Both read and write the same ~/.pi/agent (sign-ins, models, settings, sessions).
 *
 * GUI apps on macOS and Linux do not inherit the user's shell PATH, so a login shell is asked once
 * and the PATH it had remembered (platform.shellEnv; Windows apps do get the user's environment).
 *
 * PI_GUI_PI / PI_GUI_NODE pick a pi explicitly.
 */
let cached: Promise<PiEnvResult> | undefined
let shellPath = process.env.PATH ?? ''

export function resolvePiEnv(): Promise<PiEnvResult> {
    cached ??= resolveLocal().catch(error => ({ ok: false as const, error: String(error?.message ?? error) }))
    return cached
}

export function resetPiEnv() {
    cached = undefined
}

/** Environment for spawned pi processes: login-shell PATH with the real node bin dir first. */
export function piSpawnEnv(env: PiEnv): Record<string, string> {
    const base = { ...process.env as Record<string, string> }
    delete base.ELECTRON_RUN_AS_NODE
    const nodeBin = path.dirname(env.nodePath)
    const parts = [nodeBin, ...shellPath.split(path.delimiter).filter(p => p && p !== nodeBin)]
    return platform.withPath(base, parts.join(path.delimiter))
}

/** pi's bin is usually a JS file run by node; a compiled binary is spawned directly. */
export function piCommand(env: PiEnv, args: string[]): Command {
    return /\.[cm]?js$/.test(env.piPath)
        ? { file: env.nodePath, args: [env.piPath, ...args] }
        : platform.command(env.piPath, args)
}

/** `pi --version` through the same command and environment the threads use. */
async function checkVersion(env: PiEnv): Promise<PiEnvResult> {
    const { file, args, windowsVerbatimArguments } = piCommand(env, ['--version'])
    try {
        const { stdout } = await execFileAsync(file, args, { env: piSpawnEnv(env), timeout: 15_000, windowsVerbatimArguments })
        env.version = stdout.trim()
    }
    catch (error: any) {
        return { ok: false, error: `${tr('pi 无法启动：', 'pi failed to start: ')}${error?.stderr || error?.message || error}` }
    }
    return { ok: true, env }
}

let shellLoaded = false

/** The login shell's PATH (asked once), for finding other agents' commands. */
export async function loginShellPath(): Promise<string> {
    if (!shellLoaded) {
        shellLoaded = true
        const fromShell = await platform.shellEnv().catch(() => undefined)
        if (fromShell?.path)
            shellPath = fromShell.path
    }
    return shellPath
}

/**
 * Asks the login shell again, after an installer changed the profile or put a tool on PATH: later
 * lookups (agents, the pi to start) see the new PATH, and the pi env is resolved again.
 */
export async function refreshShellPath(): Promise<string> {
    shellLoaded = true
    const fromShell = await platform.shellEnv().catch(() => undefined)
    if (fromShell?.path)
        shellPath = fromShell.path
    cached = undefined
    return shellPath
}

async function resolveLocal(): Promise<PiEnvResult> {
    let nodePath = process.env.PI_GUI_NODE ?? ''
    let piPath = process.env.PI_GUI_PI ?? ''

    if (!nodePath || !piPath) {
        shellLoaded = true
        const fromShell = await platform.shellEnv().catch(() => ({ node: '', pi: '', path: undefined }))
        nodePath ||= fromShell.node
        piPath ||= fromShell.pi
        if (fromShell.path)
            shellPath = fromShell.path
    }

    if (!piPath || !existsSync(piPath))
        return { ok: false, error: tr('找不到 pi 命令。用设置向导安装，或设置环境变量 PI_GUI_PI。', 'pi command not found. Install it with the setup assistant, or set PI_GUI_PI.') }
    if (/\.[cm]?js$/.test(piPath) && (!nodePath || !existsSync(nodePath)))
        return { ok: false, error: tr('找不到 node。pi 需要 Node.js 22.19 以上，或设置环境变量 PI_GUI_NODE。', 'node not found. pi needs Node.js 22.19 or later; or set PI_GUI_NODE.') }
    return checkVersion({ nodePath, piPath, version: '' })
}
