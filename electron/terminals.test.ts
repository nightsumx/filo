// Real PTYs running the real shell: the contracts the Terminal tool window and the agent tools rely on.
import type { TerminalInfo } from '@shared/ipc'
import type { TerminalSink } from './terminals'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'
import { platform } from './platform'
import { descendants } from './platform/posix'
import { terminalEnv, Terminals } from './terminals'

const ptyDir = path.resolve('node_modules/node-pty')
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'filo-term-')))
let lists: TerminalInfo[][] = []
let terminals = new Terminals({ ptyDir, onChange: list => lists.push(list) })

afterEach(async () => {
    await terminals.closeAll()
    lists = []
    terminals = new Terminals({ ptyDir, onChange: list => lists.push(list) })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function sink(id = 1) {
    const chunks: { seq: number, data: string }[] = []
    const s: TerminalSink = {
        id,
        send: (channel, _id, seq, data) => channel === IPC.terminalData && chunks.push({ seq: seq as number, data: data as string }),
        isDestroyed: () => false,
    }
    return { sink: s, chunks, text: () => chunks.map(c => c.data).join('') }
}

async function until(check: () => boolean | Promise<boolean>, ms = 8000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (await check())
            return
        await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('timed out')
}

describe('terminals', () => {
    it('runs a login shell in the folder and streams what it prints', async () => {
        const t = terminals.create({ cwd: dir, cols: 80, rows: 24 })
        const out = sink()
        await terminals.attach(t.id, out.sink)
        terminals.write(t.id, 'echo "dir=$PWD" "sum=$((40+2))" "term=$TERM"\r')
        await until(() => out.text().includes('sum=42'))
        expect(out.text()).toContain(`dir=${dir}`)
        expect(out.text()).toContain('term=xterm-256color')
    })

    it('a late window gets the screen so far, and only chunks after it', async () => {
        const t = terminals.create({ cwd: dir })
        terminals.write(t.id, 'echo before-$((1+1))\r')
        await until(async () => (await terminals.text(t.id)).includes('before-2'))
        const late = sink(2)
        const snapshot = await terminals.attach(t.id, late.sink)
        expect(snapshot.data).toContain('before-2')
        terminals.write(t.id, 'echo after-$((2+1))\r')
        await until(() => late.text().includes('after-3'))
        expect(late.chunks.every(c => c.seq > snapshot.seq)).toBe(true)
        expect(late.text()).not.toContain('before-2')
    })

    it('reads back plain text, wrapped lines joined', async () => {
        const t = terminals.create({ cwd: dir, cols: 20, rows: 10 })
        terminals.write(t.id, `printf '\\033[31m%s\\033[0m\\n' ${'x'.repeat(50)}\r`)
        await until(async () => (await terminals.text(t.id)).includes('x'.repeat(50)))
        expect(await terminals.text(t.id)).not.toContain('\x1B[')
    })

    it('a command terminal ends with its command and keeps the output and exit code', async () => {
        const t = terminals.create({ cwd: dir, command: 'echo built; exit 3' })
        expect(t.busy).toBe(true)
        expect(await terminals.waitExit(t.id, 8000)).toBe(true)
        const info = terminals.get(t.id)!
        expect(info.exit?.code).toBe(3)
        expect(info.busy).toBe(false)
        expect(await terminals.text(t.id)).toContain('built')
        await terminals.restart(t.id)
        expect(terminals.get(t.id)?.exit).toBeUndefined()
        await terminals.waitExit(t.id, 8000)
        expect((await terminals.text(t.id)).match(/built/g)?.length).toBe(2)
    })

    it('a shell the user exits goes away', async () => {
        const t = terminals.create({ cwd: dir })
        terminals.write(t.id, 'exit\r')
        await until(() => !terminals.get(t.id))
        await until(() => lists.some(l => l.length === 0))
    })

    it('closing ends every process started in it, background jobs and their children too', async () => {
        const t = terminals.create({ cwd: dir })
        // A job that ignores SIGHUP and SIGTERM, and a child of it: only the tree walk and SIGKILL get them.
        terminals.write(t.id, `sh -c 'trap "" HUP TERM; sleep 600 & wait' &\r`)
        terminals.write(t.id, 'sleep 601\r')
        let pids: number[] = []
        await until(async () => {
            const pid = (terminals as any).entries.get(t.id).pty.pid as number
            pids = await descendants(pid)
            return pids.length >= 3
        })
        await terminals.close(t.id)
        expect(terminals.get(t.id)).toBeUndefined()
        // A killed process stays visible to kill(0) until launchd reaps it.
        const alive = () => pids.filter((pid) => {
            try {
                process.kill(pid, 0)
                return true
            }
            catch {
                return false
            }
        })
        await until(() => alive().length === 0, 3000).catch(() => {})
        expect(alive()).toEqual([])
    })

    it('tells a busy shell from an idle one by its foreground program', async () => {
        const t = terminals.create({ cwd: dir })
        await until(() => terminals.get(t.id)?.title === path.basename(platform.userShell()), 4000)
        terminals.write(t.id, 'sleep 30\r')
        await until(() => terminals.get(t.id)?.busy === true && terminals.get(t.id)?.title === 'sleep', 5000)
        expect(terminals.busyIn([dir])).toBe(1)
        terminals.write(t.id, '\x03')
        await until(() => terminals.get(t.id)?.busy === false, 5000)
    })

    it('closes the terminals of folders no window shows', async () => {
        const a = terminals.create({ cwd: dir })
        await terminals.closeOutside(new Set([dir]))
        expect(terminals.get(a.id)).toBeDefined()
        await terminals.closeOutside(new Set())
        expect(terminals.get(a.id)).toBeUndefined()
    })

    it('keeps app-only variables out of the shell', () => {
        const env = terminalEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', PI_GUI_USER_DATA: '/x', VITE_DEV_SERVER_URL: 'http://x', HOME: '/h' }, '1.0.0')
        expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', TERM: 'xterm-256color', TERM_PROGRAM: 'Filo', LANG: 'en_US.UTF-8' })
        expect(Object.keys(env).filter(k => k.startsWith('ELECTRON_') || k.startsWith('PI_GUI_') || k.startsWith('VITE_'))).toEqual([])
    })
})
