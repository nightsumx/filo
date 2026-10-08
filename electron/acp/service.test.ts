import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { platform } from '../platform'

// The login shell's PATH is a temp folder holding fake commands.
let shellPath = ''
vi.mock('../pi-env', () => ({ loginShellPath: async () => shellPath }))

const { AcpService } = await import('./service')

describe('agent availability', () => {
    let dir: string
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-avail-'))
        await mkdir(path.join(dir, 'bin'))
        shellPath = path.join(dir, 'bin')
    })
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    // A command as npm leaves one: a script with the executable bit, or a .cmd file on Windows.
    async function fakeBin(name: string) {
        const file = path.join(dir, 'bin', platform.id === 'win32' ? `${name}.cmd` : name)
        await writeFile(file, platform.id === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
        await chmod(file, 0o755)
        return file
    }

    const service = () => new AcpService(() => path.join(dir, 'acp.json'), undefined, () => path.join(dir, 'agents'))

    it('reports the CLI when only the ACP adapter is missing', async () => {
        const claude = await fakeBin('claude')
        const list = await service().availability()
        const entry = list.find(a => a.id === 'claude')!
        expect(entry).toMatchObject({ available: false, installable: true, cli: claude })
        expect(list.find(a => a.id === 'gemini')?.cli).toBeUndefined()
    })

    it('runs the adapter on PATH once it is there', async () => {
        await fakeBin('claude')
        await fakeBin('claude-agent-acp')
        const entry = (await service().availability()).find(a => a.id === 'claude')!
        expect(entry).toMatchObject({ available: true, via: 'path' })
        expect(entry.cli).toBeUndefined()
    })
})
