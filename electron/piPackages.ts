// Web access: the community pi package pi-web-access (web_search, fetch_content, …), installed the
// way pi installs any package, so pi in a terminal has it too. `pi install` puts it in
// ~/.pi/agent/npm and lists it under `packages` in settings.json; turning it off keeps it installed
// and loads none of its extensions (the object form, `"extensions": []`).
//
// Without Node.js on the Mac, the pi shipped in the app runs the install with the npm it ships
// (acp/node.ts writes `npm` and `node` for it), at the end of PATH so the user's own npm still wins.
import type { PiPackageState } from '@shared/ipc'
import { spawn } from 'node:child_process'
import { withAppNode } from './acp/node'
import { tr } from './i18n'
import { piCommand, piSpawnEnv, resolvePiEnv } from './pi-env'
import { platform } from './platform'

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Pinned: a new version is a new review of what it runs. */
export const WEB_ACCESS = { name: 'pi-web-access', source: 'npm:pi-web-access@0.37.0' }

const INSTALL_TIMEOUT_MS = 5 * 60_000

/** The package name an npm source names (`npm:@scope/name@1.2.3` → `@scope/name`); undefined for others. */
export function npmName(source: unknown): string | undefined {
    if (typeof source !== 'string' || !source.startsWith('npm:'))
        return undefined
    const spec = source.slice(4)
    const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
    return at === -1 ? spec : spec.slice(0, at)
}

const entryName = (entry: unknown) => npmName(isObject(entry) ? entry.source : entry)

/** Whether settings.json lists the package, and whether its extensions load. */
export function packageState(settings: Record<string, any>, name = WEB_ACCESS.name): PiPackageState {
    const entry = (Array.isArray(settings.packages) ? settings.packages : []).find(e => entryName(e) === name)
    if (entry === undefined)
        return { installed: false, enabled: false }
    const off = isObject(entry) && Array.isArray(entry.extensions) && entry.extensions.length === 0
    return { installed: true, enabled: !off }
}

/**
 * settings.json with the package on or off; its source (and any other filters) stay. Unchanged when
 * the package is not listed.
 */
export function withPackageEnabled(settings: Record<string, any>, enabled: boolean, name = WEB_ACCESS.name): Record<string, any> {
    if (!Array.isArray(settings.packages))
        return settings
    const packages = settings.packages.map((entry: unknown) => {
        if (entryName(entry) !== name)
            return entry
        const { extensions: _, ...rest } = isObject(entry) ? entry : { source: entry }
        const next = enabled ? rest : { ...rest, extensions: [] }
        // Nothing narrowed: back to the plain source, as `pi install` writes it.
        return Object.keys(next).length === 1 ? next.source : next
    })
    return { ...settings, packages }
}

/** `pi install <source>` with the pi the app runs; rejects with the end of its output. */
export async function installPackage(source = WEB_ACCESS.source): Promise<void> {
    const resolved = await resolvePiEnv()
    if (!resolved.ok)
        throw new Error(resolved.error)
    const env = piSpawnEnv(resolved.env)
    const withNpm = platform.withPath(env, await withAppNode(env.PATH ?? ''))
    const command = piCommand(resolved.env, ['install', source])
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command.file, command.args, { env: withNpm, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: command.windowsVerbatimArguments })
        let output = ''
        const keep = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4000)
        }
        child.stdout.on('data', keep)
        child.stderr.on('data', keep)
        const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS)
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('exit', (code, signal) => {
            clearTimeout(timer)
            if (code === 0)
                return resolve()
            const tail = output.trim().split('\n').filter(l => l.trim() && !/^npm (notice|warn)/i.test(l)).slice(-4).join('\n')
            reject(new Error(tail || tr(`pi install 退出（${code ?? signal}）`, `pi install exited (${code ?? signal})`)))
        })
    })
}
