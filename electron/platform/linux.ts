// Linux: the POSIX side of macOS (login shell, sockets, signals) with the Windows-style window. Tools
// come from PATH, not fixed /usr/bin paths; GNU tar lists tar archives only, so bsdtar is preferred.
import type { Platform } from './types'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import { chmodPtyHelper, clearSocket, directCommand, findExecutable, loginShellEnv, posixShell, posixShellArgs, posixStopTree, restrictSocket, shLauncher, socketPath } from './posix'

const execFileAsync = promisify(execFile)

async function list(tar: string, file: string): Promise<string[]> {
    const { stdout } = await execFileAsync(tar, ['-tf', file], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\n').filter(Boolean)
}

export const linux: Platform = {
    id: 'linux',
    target: `linux-${process.arch}`,

    shellEnv: () => loginShellEnv('/bin/bash'),
    userShell: () => posixShell('/bin/bash'),
    shellArgs: posixShellArgs,
    findIn: findExecutable,
    command: directCommand,
    withPath: (env, value) => ({ ...env, PATH: value }),
    launcher: shLauncher,

    stopTree: posixStopTree('ps'),

    ipcPath: socketPath,
    restrict: restrictSocket,
    clearIpc: clearSocket,

    unpack: (archive, dir, run) => archive.endsWith('.zip')
        ? run({ file: 'unzip', args: ['-q', archive, '-d', dir] })
        : run({ file: 'tar', args: ['-xzf', archive, '-C', dir] }),
    archiveEntries: file => list('bsdtar', file).catch((error) => {
        if (error?.code === 'ENOENT')
            return list('tar', file)
        throw error
    }),
    preparePty: ptyDir => chmodPtyHelper(ptyDir, linux.target),
}
