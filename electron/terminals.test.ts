// Real PTYs running the real shell: the contracts the Terminal tool window and the agent tools rely on.
import type { TerminalInfo } from '@shared/ipc'
import type { TerminalSink } from './terminals'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'
import { platform } from './platform'
import { terminalEnv, Terminals } from './terminals'

// The same steps in the shell terminals run: zsh or bash, or PowerShell on Windows.
const ps = platform.id === 'win32'
const sh = ps
    ? {
            probe: 'echo "dir=$PWD" "sum=$(40+2)" "term=$env:TERM"',
            echo: (word: string, a: number, b: number) => `echo "${word}-$(${a}+${b})"`,
            red: (text: string) => `Write-Host ("$([char]27)[31m" + '${text}' + "$([char]27)[0m")`,
            // A child of a child, beside the program in the foreground.
            tree: ['Start-Process -NoNewWindow cmd -ArgumentList \'/c\',\'ping -n 600 127.0.0.1 >nul\'', 'ping -n 601 127.0.0.1'],
            wait: 'ping -n 30 127.0.0.1',
            waiting: 'ping',
            shell: path.basename(platform.userShell()).replace(/\.exe$/i, ''),
        }
    : {
            probe: 'echo "dir=$PWD" "sum=$((40+2))" "term=$TERM"',
            echo: (word: string, a: number, b: number) => `echo ${word}-$((${a}+${b}))`,
            red: (text: string) => `printf '\\033[31m%s\\033[0m\\n' ${text}`,
            // A job that ignores SIGHUP and SIGTERM, and a child of it: only the tree walk and SIGKILL get them.
            tree: [`sh -c 'trap "" HUP TERM; sleep 600 & wait' &`, 'sleep 601'],
            wait: 'sleep 30',
            waiting: 'sleep',
            shell: path.basename(platform.userShell()),
        }

const ptyDir = path.resolve('node_modules/node-pty')
// .native: on Windows the long name, as the shell prints it, for an 8.3 temp folder (RUNNER~1).
const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'filo-term-')))
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
        terminals.write(t.id, `${sh.probe}\r`)
        await until(() => out.text().includes('sum=42'))
        expect(out.text()).toContain(`dir=${dir}`)
        expect(out.text()).toContain('term=xterm-256color')
    })

    it('a late window gets the screen so far, and only chunks after it', async () => {
        const t = terminals.create({ cwd: dir })
        terminals.write(t.id, `${sh.echo('before', 1, 1)}\r`)
        await until(async () => (await terminals.text(t.id)).includes('before-2'))
        const late = sink(2)
        const snapshot = await terminals.attach(t.id, late.sink)
        expect(snapshot.data).toContain('before-2')
        terminals.write(t.id, `${sh.echo('after', 2, 1)}\r`)
        await until(() => late.text().includes('after-3'))
        expect(late.chunks.every(c => c.seq > snapshot.seq)).toBe(true)
        expect(late.text()).not.toContain('before-2')
    })

    it('reads back plain text, wrapped lines joined', async () => {
        const t = terminals.create({ cwd: dir, cols: 20, rows: 10 })
        terminals.write(t.id, `${sh.red('x'.repeat(50))}\r`)
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
        // ConPTY starts each run on a cleared screen.
        expect((await terminals.text(t.id)).match(/built/g)?.length).toBe(ps ? 1 : 2)
    }, 20_000)

    it('a shell the user exits goes away', async () => {
        const t = terminals.create({ cwd: dir })
        terminals.write(t.id, 'exit\r')
        await until(() => !terminals.get(t.id))
        await until(() => lists.some(l => l.length === 0))
    })

    it('closing ends every process started in it, background jobs and their children too', async () => {
        const t = terminals.create({ cwd: dir })
        terminals.write(t.id, `${sh.tree[0]}\r`)
        terminals.write(t.id, `${sh.tree[1]}\r`)
        let pids: number[] = []
        await until(async () => {
            const pid = (terminals as any).entries.get(t.id).pty.pid as number
            pids = await platform.descendants(pid)
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
        await until(() => terminals.get(t.id)?.title === sh.shell, 4000)
        terminals.write(t.id, `${sh.wait}\r`)
        await until(() => terminals.get(t.id)?.busy === true && terminals.get(t.id)?.title === sh.waiting, 5000)
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
