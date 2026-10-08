import type { AcpAgentSpec } from '@shared/agents'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { platform } from '../platform'
import { installAgent } from './install'
import { appNodeBin, setAppNode, withAppNode } from './node'

// The electron package's main is the path of its binary.
const electron: string = createRequire(import.meta.url)('electron')
const npm = path.resolve('bundled-pi/node_modules/npm')
// A Mac without Node.js: only the system folders.
const BARE_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter)
const joined = (...dirs: string[]) => dirs.join(path.delimiter)
// Shebang scripts and /bin/sh: what a POSIX system runs.
const posix = platform.id !== 'win32'

describe('the app as node, without Node.js on PATH', () => {
    let dir: string
    let env: Record<string, string>
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-node-'))
        setAppNode({ dir: path.join(dir, 'node'), electron, npm })
        env = { HOME: process.env.HOME ?? dir, PATH: await withAppNode(BARE_PATH), npm_config_cache: path.join(dir, 'npm-cache') }
    })
    afterEach(async () => {
        setAppNode(undefined)
        await rm(dir, { recursive: true, force: true })
    })

    it('puts its folder last on PATH', async () => {
        const bin = await appNodeBin()
        expect(env.PATH).toBe(joined(BARE_PATH, bin!))
        expect(await withAppNode(joined('/a', '', '/b'))).toBe(joined('/a', '/b', bin!))
        setAppNode(undefined)
        expect(await withAppNode(BARE_PATH)).toBe(BARE_PATH)
    })

    it.runIf(posix)('runs scripts as node, and what they start sees a normal environment', async () => {
        const node = path.join((await appNodeBin())!, 'node')
        const script = path.join(dir, 'probe.mjs')
        await writeFile(script, [
            '#!/usr/bin/env node',
            'import { execFileSync } from "node:child_process"',
            'const child = execFileSync(process.execPath, ["-p", "process.env.ELECTRON_RUN_AS_NODE ?? \\"unset\\""]).toString().trim()',
            'console.log(JSON.stringify({ execPath: process.execPath, argv0: process.argv[0], flag: process.env.ELECTRON_RUN_AS_NODE ?? "unset", child, shell: execFileSync("/bin/sh", ["-c", "echo ${ELECTRON_RUN_AS_NODE:-unset}"]).toString().trim() }))',
        ].join('\n'), { mode: 0o755 })
        const out = JSON.parse(execFileSync(script, { env }).toString())
        // fork / spawn(process.execPath) start node again, not a second app.
        expect(out).toEqual({ execPath: node, argv0: node, flag: 'unset', child: 'unset', shell: 'unset' })
    })

    it.skipIf(!existsSync(npm))('installs an npm agent with the shipped npm, and its command runs', async () => {
        const pkg = path.join(dir, 'fake-agent')
        await mkdir(path.join(pkg, 'bin'), { recursive: true })
        await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fake-agent', version: '1.0.0', bin: { 'fake-agent': 'bin/agent.js' } }))
        await writeFile(path.join(pkg, 'bin', 'agent.js'), '#!/usr/bin/env node\nconsole.log("agent on", process.versions.node)\n', { mode: 0o755 })
        const spec: AcpAgentSpec = { id: 'gemini', label: 'Fake', bin: 'fake-agent', npm: pkg, signIn: { zh: '', en: '' } }
        const file = await installAgent(path.join(dir, 'agents'), spec, { searchPath: env.PATH, env, fetch: url => fetch(url) })
        expect(execFileSync(file, { env }).toString().trim()).toBe(`agent on ${execFileSync(electron, ['-p', 'process.versions.node'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }).toString().trim()}`)
    }, 120_000)
})
