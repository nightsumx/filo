// The app's own installs of ACP agents, one folder per agent under <root>/<id>: a pinned npm package
// (npm install --prefix) or a pinned archive (downloaded, sha256-checked, unpacked). An install is
// built in a scratch folder next to it and swapped in whole, so a failed one leaves the old in place.
// A marker file records what was installed, so a newer pinned version reads as an update.

import type { AcpAgentSpec, AgentArchive } from '@shared/agents'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tr } from '../i18n'

const MARKER = '.pi-gui-install.json'
const NPM_TIMEOUT_MS = 15 * 60_000

/** The archive for this machine, if the agent ships one. */
export const archiveFor = (spec: AcpAgentSpec): AgentArchive | undefined => spec.archive?.[`${process.platform}-${process.arch}`]

/** What an install of this spec would be: the npm package or the archive URL; undefined if none. */
export function installSource(spec: AcpAgentSpec): string | undefined {
    return spec.npm ?? archiveFor(spec)?.url
}

/** The installed command, relative to the agent's folder. */
function commandIn(spec: AcpAgentSpec): string | undefined {
    if (spec.npm)
        return path.join('node_modules', '.bin', spec.bin)
    return archiveFor(spec)?.cmd
}

export interface InstalledAgent {
    file: string
    /** It was installed from another source than the pinned one now. */
    outdated: boolean
}

/** The app's install of an agent, if there is a working one. */
export async function installedAgent(root: string, spec: AcpAgentSpec): Promise<InstalledAgent | undefined> {
    const command = commandIn(spec)
    if (!command)
        return undefined
    const dir = path.join(root, spec.id)
    const file = path.join(dir, command)
    try {
        await access(file, constants.X_OK)
    }
    catch {
        return undefined
    }
    let source: string | undefined
    try {
        source = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8'))?.source
    }
    catch {}
    return { file, outdated: source !== installSource(spec) }
}

export interface InstallTools {
    /** PATH to find npm on (the login shell's). */
    searchPath: string
    env: Record<string, string>
    fetch: (url: string) => Promise<Response>
}

/** Installs (or updates) the agent into <root>/<id>; resolves to the command. */
export async function installAgent(root: string, spec: AcpAgentSpec, tools: InstallTools): Promise<string> {
    const source = installSource(spec)
    const command = commandIn(spec)
    if (!source || !command)
        throw new Error(tr(`${spec.label} 不能在这里自动安装`, `${spec.label} cannot be installed from here`))
    await mkdir(root, { recursive: true })
    const scratch = path.join(root, `.${spec.id}-${randomUUID()}`)
    await mkdir(scratch)
    try {
        if (spec.npm)
            await npmInstall(scratch, spec.npm, tools)
        else
            await unpackArchive(scratch, archiveFor(spec)!, tools)
        await access(path.join(scratch, command), constants.X_OK).catch(() => {
            throw new Error(tr(`安装完成，但没有找到 ${command}`, `Installed, but ${command} is missing`))
        })
        await writeFile(path.join(scratch, MARKER), JSON.stringify({ source, installedAt: new Date().toISOString() }))
        const dir = path.join(root, spec.id)
        // A running agent keeps its open files; new ones start from the new folder.
        const old = `${dir}.old-${randomUUID()}`
        await rename(dir, old).catch(() => {})
        await rename(scratch, dir)
        void rm(old, { recursive: true, force: true }).catch(() => {})
        return path.join(dir, command)
    }
    catch (error) {
        await rm(scratch, { recursive: true, force: true }).catch(() => {})
        throw error
    }
}

function run(file: string, args: string[], options: { cwd: string, env: Record<string, string>, timeoutMs: number }): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-4000)
        })
        const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('exit', (code, signal) => {
            clearTimeout(timer)
            if (code === 0)
                resolve()
            else
                reject(new Error(stderr.trim().split('\n').filter(l => !/^npm (notice|warn)/i.test(l)).slice(-4).join('\n') || `${path.basename(file)} exited (${code ?? signal})`))
        })
    })
}

async function findNpm(searchPath: string): Promise<string | undefined> {
    for (const dir of searchPath.split(path.delimiter)) {
        if (!dir)
            continue
        const file = path.join(dir, 'npm')
        try {
            await access(file, constants.X_OK)
            return file
        }
        catch {}
    }
    return undefined
}

async function npmInstall(dir: string, pkg: string, tools: InstallTools) {
    const npm = await findNpm(tools.searchPath)
    if (!npm)
        throw new Error(tr('需要 Node.js 的 npm 来安装，先安装 Node.js', 'Installing needs npm; install Node.js first'))
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pi-gui-agent', private: true }))
    await run(npm, ['install', '--no-audit', '--no-fund', '--save-exact', '--omit=dev', pkg], { cwd: dir, env: { ...tools.env, PATH: tools.searchPath }, timeoutMs: NPM_TIMEOUT_MS })
}

async function unpackArchive(dir: string, archive: AgentArchive, tools: InstallTools) {
    const response = await tools.fetch(archive.url)
    if (!response.ok || !response.body)
        throw new Error(tr(`下载失败（${response.status}）`, `Download failed (${response.status})`))
    // Streamed to disk and hashed on the way (archives run to hundreds of MB).
    const file = path.join(dir, archive.url.endsWith('.zip') ? 'archive.zip' : 'archive.tar.gz')
    const hash = createHash('sha256')
    const hashing = new Transform({
        transform(chunk, _encoding, done) {
            hash.update(chunk)
            done(null, chunk)
        },
    })
    await pipeline(Readable.fromWeb(response.body as any), hashing, createWriteStream(file))
    if (hash.digest('hex') !== archive.sha256)
        throw new Error(tr('下载的文件校验不通过，没有安装', 'The download did not match its checksum; nothing was installed'))
    if (file.endsWith('.zip'))
        await run('/usr/bin/unzip', ['-q', file, '-d', dir], { cwd: dir, env: tools.env, timeoutMs: NPM_TIMEOUT_MS })
    else
        await run('/usr/bin/tar', ['-xzf', file, '-C', dir], { cwd: dir, env: tools.env, timeoutMs: NPM_TIMEOUT_MS })
    await rm(file, { force: true })
}
