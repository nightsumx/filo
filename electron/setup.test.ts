import type { SetupDeps } from './setup'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { platform } from './platform'
import { installCommand, liveSetupDeps, NODE_LTS, parseVersion, probeSetup } from './setup'

const posix = platform.id !== 'win32'

describe.runIf(posix)('setup assistant probe', () => {
    let root: string
    let home: string
    let bin: string

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'pi-gui-setup-'))
        home = path.join(root, 'home')
        bin = path.join(root, 'bin')
        await mkdir(bin, { recursive: true })
        await mkdir(home, { recursive: true })
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    /** An executable that prints `line` for --version. */
    async function tool(dir: string, name: string, line: string) {
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, name)
        await writeFile(file, `#!/bin/sh\necho '${line}'\n`)
        await chmod(file, 0o755)
        return file
    }

    function deps(over: Partial<SetupDeps> = {}): SetupDeps {
        const live = liveSetupDeps()
        return {
            os: 'darwin',
            home,
            searchPath: async () => `${bin}:/usr/bin:/bin`,
            findIn: platform.findIn,
            version: live.version,
            pi: async () => ({ bundled: true, version: '1.0.3' }),
            ...over,
        }
    }

    it('finds tools on the login shell PATH with their versions, and the installer folders of agents', async () => {
        await tool(bin, 'node', 'v24.21.0')
        await tool(bin, 'pi', '1.0.4')
        // Claude Code and Grok off PATH, where their installers put them.
        await tool(path.join(home, '.local/bin'), 'claude', '2.1.3 (Claude Code)')
        await tool(path.join(home, '.grok/bin'), 'grok', 'grok 1.0.46')
        const probe = await probeSetup(deps())
        const byId = Object.fromEntries(probe.tools.map(t => [t.id, t]))
        expect(probe.tools.map(t => t.id)).toEqual(['node', 'pi', 'claude', 'codex', 'grok'])
        expect(byId.node).toMatchObject({ path: path.join(bin, 'node'), version: '24.21.0' })
        expect(byId.pi).toMatchObject({ path: path.join(bin, 'pi'), version: '1.0.4' })
        expect(byId.claude).toMatchObject({ path: path.join(home, '.local/bin/claude'), version: '2.1.3' })
        expect(byId.grok).toMatchObject({ path: path.join(home, '.grok/bin/grok'), version: '1.0.46' })
        expect(byId.codex.path).toBeUndefined()
        expect(byId.codex.install).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
        expect(probe.pi).toEqual({ bundled: true, version: '1.0.3' })
    })

    it('reads PATH again on every probe, so a tool installed in between shows up', async () => {
        let calls = 0
        const d = deps({
            searchPath: async () => {
                calls++
                return `${bin}:/usr/bin:/bin`
            },
        })
        expect((await probeSetup(d)).tools.find(t => t.id === 'codex')?.path).toBeUndefined()
        await tool(path.join(home, '.local/bin'), 'codex', 'codex-cli 0.162.0')
        const after = (await probeSetup(d)).tools.find(t => t.id === 'codex')
        expect(after).toMatchObject({ path: path.join(home, '.local/bin/codex'), version: '0.162.0' })
        expect(calls).toBe(2)
    })

    it('does not count pi or node found only off PATH (a terminal could not run them)', async () => {
        await tool(path.join(home, '.local/bin'), 'pi', '1.0.4')
        const probe = await probeSetup(deps())
        expect(probe.tools.find(t => t.id === 'pi')?.path).toBeUndefined()
    })

    it('a tool whose --version fails is still installed, without a version', async () => {
        const file = path.join(bin, 'node')
        await writeFile(file, '#!/bin/sh\nexit 3\n')
        await chmod(file, 0o755)
        expect((await probeSetup(deps())).tools.find(t => t.id === 'node')).toMatchObject({ path: file, version: undefined })
    })
})

describe('setup assistant installers', () => {
    const base: SetupDeps = {
        os: 'darwin',
        home: '/home/u',
        searchPath: async () => '/usr/bin:/bin',
        findIn: async () => undefined,
        version: async () => undefined,
        pi: async () => ({ error: '' }),
    }

    it('runs each agent\'s official installer', async () => {
        expect(await installCommand('pi', base)).toBe('curl -fsSL https://pi.dev/install.sh | sh')
        expect(await installCommand('claude', base)).toBe('curl -fsSL https://claude.ai/install.sh | bash')
        expect(await installCommand('grok', base)).toBe('curl -fsSL https://x.ai/cli/install.sh | bash')
        expect(await installCommand('codex', { ...base, os: 'win32' })).toBe('irm https://chatgpt.com/codex/install.ps1 | iex')
        expect(await installCommand('pi', { ...base, os: 'win32' })).toBe('irm https://pi.dev/install.ps1 | iex')
    })

    it('installs Node.js with Homebrew when the shell has it, else nodejs.org\'s package on macOS', async () => {
        const brew: SetupDeps = { ...base, findIn: async name => name === 'brew' ? '/opt/homebrew/bin/brew' : undefined }
        expect(await installCommand('node', brew)).toBe('brew install node')
        expect(await installCommand('node', { ...brew, os: 'linux' })).toBe('brew install node')
        const pkg = await installCommand('node', base)
        expect(pkg).toContain(`https://nodejs.org/dist/${NODE_LTS}/node-${NODE_LTS}.pkg`)
        expect(pkg).toContain('sudo installer -pkg')
        // Linux without Homebrew: nothing the app runs.
        expect(await installCommand('node', { ...base, os: 'linux' })).toBeUndefined()
        expect(await installCommand('node', { ...base, os: 'win32' })).toMatch(/^winget install --id OpenJS\.NodeJS\.LTS /)
    })

    it('takes a test override first', async () => {
        expect(await installCommand('claude', { ...base, override: id => id === 'claude' ? 'echo hi' : undefined })).toBe('echo hi')
        expect(await installCommand('pi', { ...base, override: () => undefined })).toBe('curl -fsSL https://pi.dev/install.sh | sh')
    })

    it('reads versions out of --version lines', () => {
        expect(parseVersion('v24.21.0')).toBe('24.21.0')
        expect(parseVersion('2.1.3 (Claude Code)')).toBe('2.1.3')
        expect(parseVersion('codex-cli 0.162.0')).toBe('0.162.0')
        expect(parseVersion('1.0.4-beta.1')).toBe('1.0.4-beta.1')
        expect(parseVersion('grok')).toBeUndefined()
        expect(parseVersion(undefined)).toBeUndefined()
    })
})
