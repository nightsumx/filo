import type { AutopilotDecision, AutopilotPeer } from '@shared/capabilities'
import type { FileState, GateContext } from '../packages/capabilities/lib/autopilot'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { answerText, autopilotFacts, cardsOf, gateCard, gateOf, isAngry, readMisses, readPeers, recordMiss, sendMail, supervisorBlocks, supervisorTask, takeMail, valveOf, writePeer, writeRules } from '../packages/capabilities/lib/autopilot'

// The fixtures use POSIX paths (/repo/…), which resolve differently on Windows.
const posix = process.platform !== 'win32'

const ctx = (over: Partial<GateContext> = {}, states: Record<string, FileState> = {}): GateContext => ({
    cwd: '/repo',
    config: {},
    created: new Set(),
    fileState: async file => states[file] ?? 'clean',
    readScript: async () => undefined,
    ...over,
})
const bash = (command: string, g = ctx()) => gateOf('bash', { command }, g).then(x => x?.key)

describe('gateOf', () => {
    it('holds pushing, deploying and publishing, and lets ordinary work through', async () => {
        expect(await bash('git push')).toBe('git push')
        expect(await bash('git -C sub push origin main')).toBe('git push')
        expect(await bash('git push -f')).toBe('git push --force')
        expect(await bash('git push origin +main')).toBe('git push --force')
        expect(await bash('cd site && npx wrangler deploy -c wrangler.jsonc')).toBe('wrangler deploy')
        expect(await bash('wrangler pages deploy dist')).toBe('wrangler pages deploy')
        expect(await bash('npm publish --access public')).toBe('publish')
        expect(await bash('gh repo edit --visibility public')).toBe('gh repo edit')
        expect(await bash('git commit -m "x" --no-verify')).toBe('git --no-verify')
        expect(await bash('sudo rm -rf /opt/x')).toBe('sudo')
        expect(await bash('git status && git diff && bun test')).toBeUndefined()
        expect(await bash('git commit -am "explain git push in docs"')).toBeUndefined()
        expect(await bash('wrangler dev')).toBeUndefined()
        expect(await bash('gh pr view 3')).toBeUndefined()
    })

    it('holds discarding uncommitted work, which may be another session\'s', async () => {
        expect(await bash('git reset --hard HEAD')).toBe('git reset --hard')
        expect(await bash('git checkout -- src/a.ts')).toBe('git checkout --')
        expect(await bash('git restore src/a.ts')).toBe('git restore')
        expect(await bash('git restore --staged src/a.ts')).toBeUndefined()
        expect(await bash('git clean -fd')).toBe('git clean')
        expect(await bash('git stash drop')).toBe('git stash drop')
        expect(await bash('git checkout -b feature')).toBeUndefined()
        expect(await bash('git stash')).toBeUndefined()
    })

    it.runIf(posix)('rm: temp files, files this session created, ignored and clean tracked files go; the rest is held', async () => {
        const g = ctx({ created: new Set(['/repo/new.ts']) }, { '/repo/dist': 'ignored', '/repo/src/a.ts': 'dirty', '/repo/notes.md': 'untracked', '/elsewhere/x': 'outside' })
        expect(await bash('rm -rf /tmp/shots', g)).toBeUndefined()
        expect(await bash('rm new.ts', g)).toBeUndefined()
        expect(await bash('rm -rf dist', g)).toBeUndefined()
        expect(await bash('rm src/b.ts', g)).toBeUndefined()
        expect(await bash('rm src/a.ts', g)).toBe('rm /repo/src/a.ts')
        expect(await bash('rm -f notes.md', g)).toBe('rm /repo/notes.md')
        expect(await bash('rm /elsewhere/x', g)).toBe('rm /elsewhere/x')
        expect(await bash('rm -rf build/*', g)).toBe('rm /repo/build/*')
        expect(await bash('cd /tmp && rm -rf *', g)).toBeUndefined()
        expect(await bash('cd src && rm a.ts', g)).toBe('rm /repo/src/a.ts')
    })

    it.runIf(posix)('paid APIs in the command, or inside the script it runs; config adds patterns', async () => {
        expect(await bash('curl -X POST https://queue.fal.run/fal-ai/flux -H "Authorization: Key $FAL_KEY"')).toBe('paid fal.run')
        const g = ctx({ readScript: async file => file === '/repo/scripts/gen.ts' ? 'import { fal } from "@fal-ai/client"' : 'console.log(1)' })
        expect(await bash('bun scripts/gen.ts --count 40', g)).toBe('paid @fal-ai/')
        expect(await bash('node scripts/other.mjs', g)).toBeUndefined()
        expect(await bash('python3 gen.py', ctx({ config: { paid: ['api.example-paid.com'] }, readScript: async () => 'requests.post("https://api.example-paid.com/v1")' }))).toBe('paid api.example-paid.com')
        // A minimax search in a game is not the MiniMax API.
        expect(await bash('grep -rn minimax src')).toBeUndefined()
    })

    it.runIf(posix)('secrets: printing .env or the environment, writing .env files, protected paths', async () => {
        expect(await bash('cat .env.local')).toBe('print secrets')
        expect(await bash('cat .env.example')).toBeUndefined()
        expect(await bash('printenv')).toBe('print env')
        expect(await bash('env NODE_ENV=test bun test')).toBeUndefined()
        expect((await gateOf('write', { path: '.env' }, ctx()))?.key).toBe('write /repo/.env')
        const g = ctx({ config: { protected: ['/repo/board'] } })
        expect((await gateOf('edit', { path: 'board/score.md' }, g))?.key).toBe('protected /repo/board')
        expect(await gateOf('edit', { path: 'src/board.ts' }, g)).toBeUndefined()
    })
})

describe('supervisorBlocks', () => {
    it('the supervisor checks but never changes the repository', () => {
        expect(supervisorBlocks('bun test && npx tsc -b')).toBeUndefined()
        expect(supervisorBlocks('git diff HEAD~1')).toBeUndefined()
        expect(supervisorBlocks('rm -rf /tmp/ap-shots')).toBeUndefined()
        expect(supervisorBlocks('git commit -am fix')).toBeDefined()
        expect(supervisorBlocks('git stash')).toBeDefined()
        expect(supervisorBlocks('rm src/a.ts')).toBeDefined()
        expect(supervisorBlocks('git push')).toBeDefined()
    })
})

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (text: string, calls: { id?: string, name: string, arguments: object }[] = [], stopReason = 'stop') => ({
    type: 'message',
    message: { role: 'assistant', stopReason, content: [{ type: 'thinking', thinking: 'SECRET' }, ...(text ? [{ type: 'text', text }] : []), ...calls.map((c, i) => ({ type: 'toolCall', id: c.id ?? `c${i}`, ...c }))] },
})
const result = (toolCallId: string, text: string, isError = false) => ({ type: 'message', message: { role: 'toolResult', toolCallId, content: [{ type: 'text', text }], isError } })
const custom = (customType: string, data: unknown) => ({ type: 'custom', customType, data })
const decision = (over: Partial<AutopilotDecision>): AutopilotDecision => ({ kind: 'autopilot', id: 'ap', status: 'done', next: 'continue', message: 'go', reason: 'r', rules: [], cards: [], commands: [], startedAt: 0, endedAt: 0, workTools: 3, ...over })

describe('autopilotFacts', () => {
    it.runIf(posix)('reads the conversation, the last run\'s commands with exit codes, cards, answers and grants', () => {
        const gate = gateCard({ key: 'git push', tool: 'bash', summary: 'git push', why: '推送' })
        const card = { ...gateCard({ key: 'x', tool: 'bash', summary: 'x', why: 'x' }), gate: undefined, id: 'c2', category: 'taste' as const, title: '颜色' }
        const f = autopilotFacts([
            custom('pi-kit-autopilot-mode', { on: true }),
            user('做完登录页'),
            assistant('', [{ id: 'a', name: 'bash', arguments: { command: 'bun test' } }, { name: 'edit', arguments: { path: 'src/login.tsx' } }]),
            result('a', 'fail\nCommand exited with code 1', true),
            assistant('改完了，测试过了。'),
            custom('pi-kit-autopilot-card', gate),
            custom('pi-kit-autopilot-card', card),
            custom('pi-kit-autopilot-answer', { cardId: gate.id, choice: 'allow', via: 'app', at: 1 }),
            custom('pi-kit-autopilot', decision({ rules: ['R05'] })),
            { type: 'custom_message', customType: 'pi-kit-autopilot-message', content: '你的测试是纸糊的？', details: { from: 'supervisor' } },
            assistant('', [{ id: 'b', name: 'bash', arguments: { command: 'bun test' } }]),
            result('b', 'ok'),
            assistant('这次真的过了。'),
        ], '/repo')
        expect(f.on).toBe(true)
        expect(f.log.map(l => l.who)).toEqual(['user', 'agent', 'supervisor', 'agent'])
        expect(f.reply).toBe('这次真的过了。')
        expect(f.run.commands).toEqual([{ command: 'bun test', exitCode: 0, output: 'ok' }])
        expect(f.run.tools).toBe(1)
        expect(f.files).toEqual(['/repo/src/login.tsx'])
        expect(f.grants).toEqual(new Set(['git push']))
        expect(f.pending.map(c => c.id)).toEqual(['c2'])
        expect(f.decisions).toHaveLength(1)
        expect(JSON.stringify(f)).not.toContain('SECRET')
    })

    it('counts API errors in a row at the end', () => {
        expect(autopilotFacts([user('go'), assistant('', [], 'error'), assistant('', [], 'error')], '/r').errors).toBe(2)
        expect(autopilotFacts([user('go'), assistant('', [], 'error'), assistant('ok')], '/r').errors).toBe(0)
    })
})

describe('decisions', () => {
    it('cards get option ids, a resolved recommendation and a known category', () => {
        const [card] = cardsOf({ next: 'wait', reason: 'r', cards: [{ category: 'taste', title: '配色', question: '哪套？', options: [{ label: '暖' }, { label: '冷', id: 'cold' }], recommended: '冷' }, { title: '', question: 'x', options: [] }] as any })
        expect(card.options.map(o => o.id)).toEqual(['A', 'cold'])
        expect(card.recommended).toBe('cold')
        expect(cardsOf({ next: 'wait', reason: '', cards: [{ category: 'nonsense', title: 't', question: 'q', options: [] }] })[0].category).toBe('other')
    })

    it('valves: the same rule three times in a row, or two idle runs, stop the supervisor', () => {
        const history = [decision({ rules: ['R05', 'R18'] }), decision({ rules: ['R05'] })]
        expect(valveOf({ next: 'continue', message: 'm', reason: '', rules: ['R05'] }, 3, history)?.valve).toContain('R05')
        expect(valveOf({ next: 'continue', message: 'm', reason: '', rules: ['R07'] }, 3, history)).toBeUndefined()
        expect(valveOf({ next: 'wait', reason: '', rules: ['R05'] }, 3, history)).toBeUndefined()
        const idle = [decision({ workTools: 0 }), decision({ workTools: 0, rules: ['R02'] })]
        const held = valveOf({ next: 'continue', message: '继续', reason: '', rules: [] }, 0, idle)!
        expect(held.valve).toContain('什么都没做')
        expect(held.card.held).toBe('继续')
    })

    it('answers reach the agent as the user\'s words', () => {
        const gate = gateCard({ key: 'git push', tool: 'bash', summary: 'git push origin main', why: '推送' })
        expect(answerText(gate, { choice: 'allow' })).toContain('用户批准了：git push origin main')
        expect(answerText(gate, { choice: 'deny', text: '先别推' })).toContain('别做这一步：先别推')
        const [card] = cardsOf({ next: 'wait', reason: '', cards: [{ title: '配色', question: '?', options: [{ label: '暖' }] }] })
        expect(answerText(card, { choice: 'A', text: '再暗一点' })).toBe('用户对「配色」的决定：暖。再暗一点')
    })

    it.runIf(posix)('the task carries rules, conversation, commands, peers and never the agent\'s reasoning', () => {
        const facts = autopilotFacts([user('做完登录页'), assistant('', [{ id: 'a', name: 'bash', arguments: { command: 'bun test' } }]), result('a', 'ok'), assistant('好了，要我提交吗？')], '/repo')
        const peer: AutopilotPeer = { session: 's2', pid: 1, cwd: '/repo', root: '/repo', topic: '设置页', state: 'running', files: ['/repo/src/settings.tsx'], cards: [], updatedAt: 0 }
        const task = supervisorTask({ facts, changes: { scope: 'thread', files: ['src/a.ts'], diff: '+x', unshown: [] }, peers: [peer], rules: 'R02 已授权就别再问', session: 's1', cwd: '/repo' })
        expect(task).toContain('R02 已授权就别再问')
        expect(task).toContain('要我提交吗')
        expect(task).toContain('`bun test` → 0')
        expect(task).toContain('session `s2` (running, 设置页), files: src/settings.tsx')
        expect(task).not.toContain('SECRET')
    })

    it('anger marks a miss', () => {
        expect(isAngry('你的测试是纸糊的？')).toBe(true)
        expect(isAngry('继续')).toBe(false)
    })
})

describe('board, mail and misses', () => {
    let dir = ''
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

    it('peers of exited processes disappear; mail is read once; misses after a time; rules keep a backup', () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'ap-test-'))
        const peer = (session: string, pid: number): AutopilotPeer => ({ session, pid, cwd: '/r', root: '/r', state: 'idle', files: [], cards: [], updatedAt: 0 })
        writePeer(dir, peer('alive', process.pid))
        writePeer(dir, peer('gone', 999_999))
        expect(readPeers(dir).map(p => p.session)).toEqual(['alive'])
        expect(readPeers(dir).map(p => p.session)).toEqual(['alive'])

        sendMail(dir, 'alive', { kind: 'note', from: 'x', text: 'one', at: 1 })
        sendMail(dir, 'alive', { kind: 'answer', cardId: 'c', answer: { choice: 'A' }, at: 2 })
        expect(takeMail(dir, 'alive').map(m => m.kind)).toEqual(['note', 'answer'])
        expect(takeMail(dir, 'alive')).toEqual([])

        recordMiss(dir, { at: 10, cwd: '/r', session: 's', text: 'a', phase: 'idle' })
        recordMiss(dir, { at: 20, cwd: '/r', session: 's', text: 'b', phase: 'idle' })
        expect(readMisses(dir, 10).map(m => m.text)).toEqual(['b'])

        writeRules(dir, 'v1')
        const backup = writeRules(dir, 'v2')
        expect(path.basename(backup).startsWith('rules.')).toBe(true)
    })
})
