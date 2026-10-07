import type { SessionItem } from '@shared/ipc'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseEdits, repoEdits } from '../edits'
import { indexSession } from '../search'
import { mirrorFile, mirrorFiles, mirrorKey, mirrorText } from './mirror'
import { AcpService } from './service'

const at = Date.parse('2026-01-03T00:00:00Z')
const items: SessionItem[] = [
    { entryId: '0', message: { role: 'user', content: [{ type: 'text', text: 'rename the flag' }], timestamp: at } as any },
    { entryId: '1', message: { role: 'assistant', content: [{ type: 'text', text: 'Renaming it.' }, { type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: '/repo/a.ts', oldText: 'a', newText: 'b' } }], stopReason: 'toolUse', timestamp: at + 1 } as any },
    { entryId: '2', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'edit', content: [], isError: false, timestamp: at + 2 } as any, endedAt: at + 2 },
    { entryId: '3', message: { role: 'assistant', content: [{ type: 'text', text: 'Renamed the flag everywhere.' }], stopReason: 'stop', timestamp: at + 3 } as any },
]

describe('acp mirror', () => {
    it('maps a session key to a file and back', () => {
        const file = mirrorFile('/m', 'acp:codex:01a1/b')!
        expect(file).toBe('/m/codex/01a1%2Fb.jsonl')
        expect(mirrorKey('/m', file)).toBe('acp:codex:01a1/b')
        expect(mirrorKey('/m', '/m/nobody/x.jsonl')).toBeUndefined()
        expect(mirrorKey('/m', '/elsewhere/codex/x.jsonl')).toBeUndefined()
        expect(mirrorFile('/m', '/sessions/x.jsonl')).toBeUndefined()
    })

    it('writes a pi session file the edit log and search read', () => {
        const text = mirrorText({ sessionId: 's1', cwd: '/repo', createdAt: at, name: 'Rename flag' }, items)
        expect(parseEdits(text)).toEqual({ cwd: '/repo', title: 'Rename flag', edits: [{ path: '/repo/a.ts', at: at + 1 }] })
        const indexed = indexSession(Buffer.from(text))!
        expect(indexed).toMatchObject({ cwd: '/repo', name: 'Rename flag', firstPrompt: 'rename the flag' })
        // Entry ids are the snapshot's: a search hit opens at that message.
        expect(indexed.entries.map(e => e.id)).toEqual(['0', '1', '3'])
    })
})

describe('acpService index', () => {
    let dir: string
    const env = { ...process.env }
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-acp-'))
    })
    afterEach(async () => {
        process.env = { ...env }
        await rm(dir, { recursive: true, force: true })
    })

    it('folds in the agent\'s own list: hidden ones stay out, vanished imports go', async () => {
        const file = path.join(dir, 'acp-sessions.json')
        const service = new AcpService(() => file, () => path.join(dir, 'mirror'))
        const projects = new Set(['/repo'])
        service.merge('codex', [
            { sessionId: 'a', cwd: '/repo', title: 'From the terminal', updatedAt: at },
            { sessionId: 'b', cwd: '/scratch', title: 'Elsewhere', updatedAt: at },
            { sessionId: 'c', cwd: '/repo', updatedAt: at + 5 },
        ], true)
        const list = () => (service as any).summaries(projects).map((s: any) => [s.path, s.name ?? null])
        // Folders the app does not know stay out of the sidebar.
        expect(list()).toEqual([['acp:codex:a', 'From the terminal'], ['acp:codex:c', null]])

        service.remove('acp:codex:a')
        service.merge('codex', [{ sessionId: 'a', cwd: '/repo', updatedAt: at + 9 }], true)
        // Removed: stays hidden. Gone from the agent's whole list: gone here (b, c).
        expect(list()).toEqual([])
        // A partial list removes nothing.
        service.merge('codex', [{ sessionId: 'd', cwd: '/repo', updatedAt: at }], false)
        service.merge('codex', [], false)
        expect(list()).toEqual([['acp:codex:d', null]])

        await (service as any).saving
        const saved = JSON.parse(await readFile(file, 'utf8'))
        expect(saved.hidden).toEqual(['acp:codex:a'])
        const again = new AcpService(() => file)
        again.merge('codex', [{ sessionId: 'a', cwd: '/repo', updatedAt: at }], false)
        expect((again as any).summaries(projects).map((s: any) => s.path)).toEqual(['acp:codex:d'])
    })

    it('reports ACP edits under the session key', async () => {
        process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, 'sessions')
        const repo = path.join(dir, 'repo')
        await mkdir(repo, { recursive: true })
        const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z' } })
        git('init', '-q')
        await writeFile(path.join(repo, 'a.ts'), 'a\n')
        git('add', '-A')
        git('commit', '-qm', 'init', '--date=2026-01-01T00:00:00Z')
        await writeFile(path.join(repo, 'a.ts'), 'b\n')

        const mirrors = path.join(dir, 'mirror')
        const file = mirrorFile(mirrors, 'acp:claude:s1')!
        await mkdir(path.dirname(file), { recursive: true })
        const edited = items.map(i => JSON.parse(JSON.stringify(i).replaceAll('/repo/', `${repo}/`)))
        await writeFile(file, mirrorText({ sessionId: 's1', cwd: repo, createdAt: at, name: 'Rename flag' }, edited))
        expect(await mirrorFiles(mirrors)).toEqual([file])

        const edits = await repoEdits(repo, await mirrorFiles(mirrors), f => mirrorKey(mirrors, f))
        expect(edits.files).toEqual({ 'a.ts': [{ session: 'acp:claude:s1', title: 'Rename flag', at: at + 1 }] })
    })
})
