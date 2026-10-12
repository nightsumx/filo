// macOS: the POSIX basics, with fixed system tool paths and QuickLook thumbnails (window/darwin.ts: the rest).
import type { Platform } from './types'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { chmodPtyHelper, clearSocket, descendants, directCommand, findExecutable, loginShellEnv, posixShell, posixShellArgs, posixStopTree, restrictSocket, shLauncher, socketPath } from './posix'

const execFileAsync = promisify(execFile)

/**
 * <App>.app/Contents/MacOS/<Name> → <App>.app/Contents/Frameworks/<Name> Helper.app/Contents/MacOS/<Name> Helper.
 * The main executable's Info.plist has no LSUIElement, so LaunchServices registers a node run of it as
 * a foreground app that never connects to the WindowServer: a Dock icon that keeps bouncing. The
 * Helper (LSUIElement=true) runs as node the same way, without one. Not in a bundle: `electron` itself.
 */
export function macNodeRuntime(electron: string, exists: (file: string) => boolean = existsSync): string {
    const macos = path.dirname(electron)
    if (path.basename(macos) !== 'MacOS')
        return electron
    const name = `${path.basename(electron)} Helper`
    const helper = path.join(macos, '..', 'Frameworks', `${name}.app`, 'Contents', 'MacOS', name)
    return exists(helper) ? helper : electron
}

export const darwin: Platform = {
    id: 'darwin',
    target: `darwin-${process.arch}`,

    shellEnv: () => loginShellEnv('/bin/zsh'),
    userShell: () => posixShell('/bin/zsh'),
    shellArgs: posixShellArgs,
    findIn: findExecutable,
    command: directCommand,
    withPath: (env, value) => ({ ...env, PATH: value }),
    nodeRuntime: electron => macNodeRuntime(electron),
    launcher: shLauncher,

    descendants: pid => descendants(pid, '/bin/ps'),
    foreground: async pty => pty.process,
    stopTree: posixStopTree('/bin/ps'),

    ipcPath: socketPath,
    restrict: restrictSocket,
    clearIpc: clearSocket,

    unpack: (archive, dir, run) => archive.endsWith('.zip')
        ? run({ file: '/usr/bin/unzip', args: ['-q', archive, '-d', dir] })
        : run({ file: '/usr/bin/tar', args: ['-xzf', archive, '-C', dir] }),
    // bsdtar reads zip, jar, tar, tgz, 7z, rar...
    archiveEntries: async (file) => {
        const { stdout } = await execFileAsync('/usr/bin/tar', ['-tf', file], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })
        return stdout.split('\n').filter(Boolean)
    },
    // qlmanage waits forever on a type it has no generator for, so this gives up after a few seconds.
    thumbnail: async (file, out) => {
        try {
            await execFileAsync('/usr/bin/qlmanage', ['-t', '-s', '1200', '-o', out, file], { timeout: 10_000 })
            return await readFile(path.join(out, `${path.basename(file)}.png`))
        }
        catch {
            return null
        }
    },
    preparePty: ptyDir => chmodPtyHelper(ptyDir, darwin.target),
}
