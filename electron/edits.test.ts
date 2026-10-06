import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseEdits, repoEdits, resolveToolPath } from './edits'

const lines = (...records: object[]) => records.map(r => JSON.stringify(r)).join('\n')
const header = (cwd: string) => ({ type: 'session', version: 3, id: 's', timestamp: '2026-01-01T00:00:00.000Z', cwd })
const call = (id: string, at: string, name: string, args: object) => ({
    type: 'message',
    id: `m-${id}`,
    parentId: null,
    timestamp: at,
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', timestamp: 0 },
})
const result = (id: string, isError: boolean) => ({
    type: 'message',
    id: `r-${id}`,
    parentId: `m-${id}`,
    timestamp: '2026-01-01T00:00:03.000Z',
    message: { role: 'toolResult', toolCallId: id, toolName: 'edit', content: [], isError, timestamp: 0 },
})
const prompt = (text: string) => ({ type: 'message', id: 'u', parentId: null, timestamp: '2026-01-01T00:00:00.500Z', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } })

describe('parseEdits', () => {
    it('keeps successful edit / write calls, resolved against the session cwd', () => {
        const text = lines(
            header('/repo'),
            prompt('fix the build\nplease'),
            call('a', '2026-01-01T00:00:01.000Z', 'edit', { path: 'src/a.ts', oldText: 'x', newText: 'y' }),
            result('a', false),
            call('b', '2026-01-01T00:00:02.000Z', 'write', { path: '/elsewhere/b.ts', content: '' }),
            call('c', '2026-01-01T00:00:02.000Z', 'edit', { path: 'failed.ts' }),
            result('c', true),
            call('d', '2026-01-01T00:00:02.000Z', 'read', { path: 'read-only.ts' }),
        )
        expect(parseEdits(text)).toEqual({
            cwd: '/repo',
            title: 'fix the build',
            edits: [
                { path: '/repo/src/a.ts', at: Date.parse('2026-01-01T00:00:01.000Z') },
                { path: '/elsewhere/b.ts', at: Date.parse('2026-01-01T00:00:02.000Z') },
            ],
        })
    })

    it('resolves @ and ~ like pi', () => {
        expect(resolveToolPath('/repo', '@src/a.ts')).toBe('/repo/src/a.ts')
        expect(resolveToolPath('/repo', '~/x.ts')).toBe(path.join(os.homedir(), 'x.ts'))
    })
})

describe('repoEdits', () => {
    let dir: string
    const env = { ...process.env }
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pi-edits-'))
        process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, 'sessions')
    })
    afterEach(async () => {
        process.env = { ...env }
        await rm(dir, { recursive: true, force: true })
    })

    it('lists the sessions per uncommitted file, newer than the last commit', async () => {
        // tmpdir is a symlink on macOS (/var → /private/var): sessions use the unresolved path.
        const repo = path.join(dir, 'repo')
        await mkdir(path.join(repo, 'src'), { recursive: true })
        const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd: repo })
        git('init', '-q')
        await writeFile(path.join(repo, 'src/a.ts'), 'a\n')
        await writeFile(path.join(repo, 'b.ts'), 'b\n')
        await writeFile(path.join(repo, 'clean.ts'), 'c\n')
        git('add', '-A')
        git('commit', '-qm', 'init', '--date=2026-01-01T00:00:00Z')
        execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--amend', '--no-edit'], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z' } })
        await writeFile(path.join(repo, 'src/a.ts'), 'a2\n')
        await writeFile(path.join(repo, 'b.ts'), 'b2\n')

        const sessions = path.join(dir, 'sessions', '--repo--')
        await mkdir(sessions, { recursive: true })
        const one = path.join(sessions, 'one.jsonl')
        const two = path.join(sessions, 'two.jsonl')
        const old = path.join(sessions, 'old.jsonl')
        await writeFile(one, lines(header(repo), prompt('first'), call('1', '2026-01-03T00:00:00.000Z', 'edit', { path: 'src/a.ts' }), call('2', '2026-01-03T00:00:01.000Z', 'edit', { path: 'clean.ts' })))
        await writeFile(two, lines(header(path.join(repo, 'src')), prompt('second'), call('3', '2026-01-04T00:00:00.000Z', 'write', { path: 'a.ts' }), call('4', '2026-01-01T12:00:00.000Z', 'edit', { path: '../b.ts' })))
        await writeFile(old, lines(header(repo), prompt('old'), call('5', '2026-01-01T12:00:00.000Z', 'edit', { path: 'b.ts' })))
        // Last written before the commit: skipped without being read.
        await utimes(old, new Date('2026-01-01T12:00:00Z'), new Date('2026-01-01T12:00:00Z'))

        const edits = await repoEdits(repo)
        expect(edits.files).toEqual({
            'src/a.ts': [
                { session: two, title: 'second', at: Date.parse('2026-01-04T00:00:00.000Z') },
                { session: one, title: 'first', at: Date.parse('2026-01-03T00:00:00.000Z') },
            ],
        })
    })
})
