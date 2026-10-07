import type { AcpAgentSpec } from '@shared/agents'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archiveFor, installAgent, installedAgent } from './install'

const platform = `${process.platform}-${process.arch}`
const tools = (fetch: (url: string) => Promise<Response>) => ({ searchPath: process.env.PATH ?? '', env: { ...process.env } as Record<string, string>, fetch })

describe('agent installs', () => {
    let dir: string
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-install-'))
    })
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    /** A tar.gz holding pkg/agent (executable), and its sha256. */
    async function archive(body: string) {
        const src = path.join(dir, `src-${Math.random()}`)
        await mkdir(path.join(src, 'pkg'), { recursive: true })
        await writeFile(path.join(src, 'pkg', 'agent'), `#!/bin/sh\necho ${body}\n`)
        await chmod(path.join(src, 'pkg', 'agent'), 0o755)
        const file = path.join(dir, `a-${Math.random()}.tar.gz`)
        execFileSync('tar', ['-czf', file, '-C', src, 'pkg'])
        const data = await readFile(file)
        return { data, sha256: createHash('sha256').update(data).digest('hex') }
    }
    const spec = (url: string, sha256: string): AcpAgentSpec => ({ id: 'cursor', label: 'Fake', bin: 'agent', signIn: { zh: '', en: '' }, archive: { [platform]: { url, sha256, cmd: 'pkg/agent' } } })
    const serve = (data: Buffer) => async () => new Response(data)

    it('unpacks a checked archive, and a newer pin reads as an update', async () => {
        const root = path.join(dir, 'agents')
        const v1 = await archive('one')
        const s1 = spec('https://example.test/v1.tar.gz', v1.sha256)
        expect(archiveFor(s1)?.cmd).toBe('pkg/agent')
        expect(await installedAgent(root, s1)).toBeUndefined()

        const file = await installAgent(root, s1, tools(serve(v1.data)))
        expect(file).toBe(path.join(root, 'cursor', 'pkg', 'agent'))
        expect(execFileSync(file).toString().trim()).toBe('one')
        expect(await installedAgent(root, s1)).toEqual({ file, outdated: false })

        const v2 = await archive('two')
        const s2 = spec('https://example.test/v2.tar.gz', v2.sha256)
        expect((await installedAgent(root, s2))?.outdated).toBe(true)
        await installAgent(root, s2, tools(serve(v2.data)))
        expect(execFileSync(file).toString().trim()).toBe('two')
        expect(await installedAgent(root, s2)).toEqual({ file, outdated: false })
        // No scratch folders left behind (the old copy goes in the background).
        await new Promise(r => setTimeout(r, 100))
        expect((await readdir(root)).filter(n => n.startsWith('.'))).toEqual([])
    })

    it('refuses a download that does not match its checksum, and keeps the old install', async () => {
        const root = path.join(dir, 'agents')
        const good = await archive('good')
        await installAgent(root, spec('https://example.test/good.tar.gz', good.sha256), tools(serve(good.data)))
        const evil = await archive('evil')
        await expect(installAgent(root, spec('https://example.test/new.tar.gz', good.sha256.replace(/^./, '0')), tools(serve(evil.data)))).rejects.toThrow(/checksum|校验/)
        expect(execFileSync(path.join(root, 'cursor', 'pkg', 'agent')).toString().trim()).toBe('good')
        expect((await readdir(root)).filter(n => n.startsWith('.'))).toEqual([])
    })

    it('installs a pinned npm package with its bin', async () => {
        // A local package tarball stands in for the registry.
        const pkg = path.join(dir, 'pkg')
        await mkdir(path.join(pkg, 'bin'), { recursive: true })
        await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fake-acp-agent', version: '1.0.0', bin: { 'fake-acp': 'bin/fake.js' } }))
        await writeFile(path.join(pkg, 'bin', 'fake.js'), '#!/usr/bin/env node\nconsole.log("npm ok")\n')
        const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg }).toString().trim()
        const npmSpec: AcpAgentSpec = { id: 'codex', label: 'Fake', bin: 'fake-acp', signIn: { zh: '', en: '' }, npm: path.join(dir, tgz) }
        const root = path.join(dir, 'agents')
        const file = await installAgent(root, npmSpec, tools(async () => new Response('')))
        expect(file).toBe(path.join(root, 'codex', 'node_modules', '.bin', 'fake-acp'))
        expect(execFileSync(file).toString().trim()).toBe('npm ok')
        expect(await installedAgent(root, npmSpec)).toEqual({ file, outdated: false })
    }, 60_000)
})
