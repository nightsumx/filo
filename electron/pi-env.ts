import type { PiEnv, PiEnvResult } from '@shared/ipc'
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { tr } from './i18n'

const execFileAsync = promisify(execFile)

/**
 * GUI apps on macOS do not inherit the user's shell PATH, and version managers like fnm put
 * `node`/`pi` behind per-shell symlinks that disappear later. So: ask a login shell once,
 * resolve the real files immediately, and remember the PATH that shell had.
 */
let cached: Promise<PiEnvResult> | undefined
let shellPath = process.env.PATH ?? ''

export function resolvePiEnv(): Promise<PiEnvResult> {
    cached ??= resolveUncached().catch(error => ({ ok: false as const, error: String(error?.message ?? error) }))
    return cached
}

export function resetPiEnv() {
    cached = undefined
}

/** Environment for spawned pi processes: login-shell PATH with the real node bin dir first. */
export function piSpawnEnv(env: PiEnv): Record<string, string> {
    const nodeBin = path.dirname(env.nodePath)
    const parts = [nodeBin, ...shellPath.split(':').filter(p => p && p !== nodeBin)]
    return { ...process.env as Record<string, string>, PATH: parts.join(':') }
}

/** pi's bin is usually a JS file run by node; a compiled binary is spawned directly. */
export function piCommand(env: PiEnv, args: string[]): { file: string, args: string[] } {
    return /\.[cm]?js$/.test(env.piPath)
        ? { file: env.nodePath, args: [env.piPath, ...args] }
        : { file: env.piPath, args }
}

async function resolveUncached(): Promise<PiEnvResult> {
    let nodePath = process.env.PI_GUI_NODE ?? ''
    let piPath = process.env.PI_GUI_PI ?? ''

    if (!nodePath || !piPath) {
        const fromShell = await queryLoginShell()
        nodePath ||= fromShell.node
        piPath ||= fromShell.pi
        if (fromShell.path)
            shellPath = fromShell.path
    }

    if (!piPath || !existsSync(piPath))
        return { ok: false, error: tr('找不到 pi 命令。请先安装：npm install -g @earendil-works/pi-coding-agent，或设置环境变量 PI_GUI_PI。', 'pi command not found. Install it with npm install -g @earendil-works/pi-coding-agent, or set PI_GUI_PI.') }
    if (/\.[cm]?js$/.test(piPath) && (!nodePath || !existsSync(nodePath)))
        return { ok: false, error: tr('找不到 node。pi 需要 Node.js 22.19 以上，或设置环境变量 PI_GUI_NODE。', 'node not found. pi needs Node.js 22.19 or later; or set PI_GUI_NODE.') }

    const env: PiEnv = { nodePath, piPath, version: '' }
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
