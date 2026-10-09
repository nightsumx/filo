// Linux: the POSIX side of macOS (login shell, sockets, signals) with the Windows-style window. Tools
// come from PATH, not fixed /usr/bin paths; GNU tar lists tar archives only, so bsdtar is preferred,
// and without it a zip (jar, docx...) is listed by unzip.
import type { Platform } from './types'
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import process from 'node:process'
import path from 'node:path'
import { promisify } from 'node:util'
import { chmodPtyHelper, descendants, clearSocket, directCommand, findExecutable, loginShellEnv, posixShell, posixShellArgs, posixStopTree, restrictSocket, shLauncher, socketPath } from './posix'

const execFileAsync = promisify(execFile)

async function list(program: string, args: string[]): Promise<string[]> {
    const { stdout } = await execFileAsync(program, args, { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\n').filter(Boolean)
}

/** A zip by its first bytes (local file header, or the end record of an empty one). */
async function isZip(file: string): Promise<boolean> {
    const handle = await open(file, 'r')
    try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0)
        const magic = buffer.subarray(0, bytesRead).toString('latin1')
        return magic === 'PK\x03\x04' || magic === 'PK\x05\x06'
    }
    finally {
        await handle.close()
    }
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

    descendants: pid => descendants(pid, 'ps'),
    // node-pty reports the foreground program's argv[0], which can be a path (/bin/bash).
    foreground: async pty => path.basename(pty.process),
    stopTree: posixStopTree('ps'),

    ipcPath: socketPath,
    restrict: restrictSocket,
    clearIpc: clearSocket,

    unpack: (archive, dir, run) => archive.endsWith('.zip')
        ? run({ file: 'unzip', args: ['-q', archive, '-d', dir] })
        : run({ file: 'tar', args: ['-xzf', archive, '-C', dir] }),
    archiveEntries: file => list('bsdtar', ['-tf', file]).catch(async (error) => {
        if (error?.code !== 'ENOENT')
            throw error
        return await isZip(file) ? list('unzip', ['-Z1', file]) : list('tar', ['-tf', file])
    }),
    preparePty: ptyDir => chmodPtyHelper(ptyDir, linux.target),
}
