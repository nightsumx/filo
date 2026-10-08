// node and npm for the agents the app installs, on a Mac without Node.js. Those agents are npm
// packages: installing them needs npm, and their commands are `#!/usr/bin/env node` scripts. The app
// carries both already: its Electron runs as node (ELECTRON_RUN_AS_NODE=1), and it ships an npm with
// the bundled pi (bundled-pi/package.json). Small scripts in <dir>/bin make them `node`, `npm` and
// `npx`; that folder goes at the end of the agents' PATH, so the user's own Node.js still wins.
//
// The node script starts Electron with a preload that drops ELECTRON_RUN_AS_NODE again, so what the
// agent runs (someone's own Electron app among it) sees a normal environment, and that makes
// process.execPath the script, so an agent that starts node again (fork, spawn(process.execPath))
// gets node and not a second app. With execPath in <dir>/bin, npm's global prefix is <dir>: an
// `npm install -g` lands next to the scripts, on the same PATH.

import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { platform } from '../platform'

export interface AppNode {
    /** Where the scripts go (rewritten when the app moves). */
    dir: string
    /** The Electron binary to run as node. */
    electron: string
    /** The shipped npm (its package folder); none, no npm or npx. */
    npm?: string
}

let config: AppNode | undefined
let written: Promise<string | undefined> | undefined

export function setAppNode(next: AppNode | undefined) {
    config = next
    written = undefined
}

/** The folder holding the scripts, written on first use; undefined when there is none. */
export function appNodeBin(): Promise<string | undefined> {
    if (!config)
        return Promise.resolve(undefined)
    written ??= writeScripts(config).catch(() => {
        written = undefined
        return undefined
    })
    return written
}

/** `searchPath` with the app's node folder last, for the agents the app installed. */
export async function withAppNode(searchPath: string): Promise<string> {
    const bin = await appNodeBin()
    return bin ? [...searchPath.split(path.delimiter).filter(Boolean), bin].join(path.delimiter) : searchPath
}

async function writeScripts({ dir, electron, npm }: AppNode): Promise<string> {
    const bin = path.join(dir, 'bin')
    const preload = path.join(dir, 'preload.cjs')
    const nodeLauncher = platform.launcher('node', { ELECTRON_RUN_AS_NODE: '1' }, [electron, '--require', preload])
    const node = path.join(bin, nodeLauncher.file)
    await mkdir(bin, { recursive: true })
    await put(preload, [
        '// Loaded by bin/node before the script it runs (electron/acp/node.ts).',
        'delete process.env.ELECTRON_RUN_AS_NODE',
        `process.execPath = ${JSON.stringify(node)}`,
        'process.argv[0] = process.execPath',
        '',
    ].join('\n'))
    await put(node, nodeLauncher.text, true)
    // A development build has it only after scripts/bundle-pi.sh.
    const hasNpm = !!npm && await access(path.join(npm, 'bin', 'npm-cli.js')).then(() => true, () => false)
    for (const [name, cli] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
        const launcher = platform.launcher(name, {}, [node, path.join(npm ?? '', 'bin', cli)])
        const file = path.join(bin, launcher.file)
        if (hasNpm)
            await put(file, launcher.text, true)
        else
            await rm(file, { force: true })
    }
    return bin
}

/** Writes a file unless it holds this already; whole (a running agent may be reading it). */
async function put(file: string, text: string, executable = false) {
    const old = await readFile(file, 'utf8').catch(() => undefined)
    if (old === text)
        return
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, text)
    if (executable)
        await chmod(tmp, 0o755)
    await rename(tmp, file)
}
