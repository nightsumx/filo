import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hookSettings, listClaudeSessions, projectSlug, sessionFile } from './claudeTui'

describe('claude code session files', () => {
    let dir: string
    let cwd: string
    beforeEach(async () => {
        dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'claude-tui-')))
        cwd = path.join(dir, 'my.repo')
        await mkdir(cwd)
    })
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    const line = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`
    async function session(project: string, id: string, records: Record<string, unknown>[]) {
        await mkdir(path.join(dir, 'config', 'projects', project), { recursive: true })
        const file = path.join(dir, 'config', 'projects', project, `${id}.jsonl`)
        await writeFile(file, records.map(line).join(''))
        return file
    }

    it('finds a session in its project folder, else in any', async () => {
        const config = path.join(dir, 'config')
        expect(projectSlug(cwd)).toBe(cwd.replace(/[^a-z0-9]/gi, '-'))
        const home = await session(projectSlug(cwd), 's1', [])
        expect(sessionFile(config, cwd, 's1')).toBe(home)
        const moved = await session('-elsewhere', 's2', [])
        expect(sessionFile(config, cwd, 's2')).toBe(moved)
        expect(sessionFile(config, cwd, 'new')).toBe(path.join(config, 'projects', projectSlug(cwd), 'new.jsonl'))
    })

    it('lists interactive sessions with their folder and latest title, newest first', async () => {
        const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'config') }
        await session('p', 'a', [
            { type: 'user', cwd, entrypoint: 'cli', message: { role: 'user', content: 'first' }, uuid: '1' },
            { type: 'ai-title', aiTitle: 'Generated' },
            { type: 'custom-title', customTitle: 'Named' },
        ])
        await new Promise(resolve => setTimeout(resolve, 20))
        await session('p', 'b', [{ type: 'user', cwd, entrypoint: 'cli', message: { role: 'user', content: 'second' }, uuid: '1' }, { type: 'ai-title', aiTitle: 'Only AI' }])
        // `claude -p` runs, and files with no prompt, are not threads.
        await session('p', 'c', [{ type: 'user', cwd, entrypoint: 'sdk-cli', message: { role: 'user', content: 'x' }, uuid: '1' }])
        await session('p', 'd', [{ type: 'mode', mode: 'normal' }])
        const { sessions } = await listClaudeSessions(env)
        expect(sessions.map(s => [s.sessionId, s.cwd, s.title])).toEqual([['b', cwd, 'Only AI'], ['a', cwd, 'Named']])
    })

    it('tells hooks the settings turn off: the user\'s or the project\'s, or an administrator\'s', async () => {
        const config = path.join(dir, 'config')
        const managed = path.join(dir, 'managed')
        await mkdir(path.join(cwd, '.claude'), { recursive: true })
        await mkdir(path.join(managed, 'managed-settings.d'), { recursive: true })
        await mkdir(config, { recursive: true })
        expect(hookSettings(config, cwd, [managed])).toEqual({ urlAllowlist: false })
        await writeFile(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }))
        expect(hookSettings(config, cwd, [managed]).issue).toEqual({ cause: 'disabled', files: [path.join(cwd, '.claude', 'settings.local.json')] })
        // An allowlist for HTTP hooks: the adapter posts through curl instead.
        await writeFile(path.join(config, 'settings.json'), JSON.stringify({ allowedHttpHookUrls: ['https://x.example/*'] }))
        expect(hookSettings(config, cwd, [managed]).urlAllowlist).toBe(true)
        // An administrator's word wins, from the base file or a drop-in.
        await writeFile(path.join(managed, 'managed-settings.d', '10-hooks.json'), JSON.stringify({ allowManagedHooksOnly: true }))
        expect(hookSettings(config, cwd, [managed]).issue).toEqual({ cause: 'policy', files: [path.join(managed, 'managed-settings.d', '10-hooks.json')] })
    })
})
