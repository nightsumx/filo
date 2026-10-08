// Windows has no `ps` and node no process listing, and ConPTY does not say what runs in a terminal. One
// PowerShell, started when asked and gone after a quiet spell, answers from WMI (about 15 ms a query);
// calls close together share an answer, so a poll over every terminal makes one query.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

export interface ProcessRow {
    pid: number
    parent: number
    name: string
}

/** Answers this fresh are reused. */
const FRESH_MS = 300
/** The helper ends after this long without a query. */
const IDLE_MS = 15_000
const END = '__END__'

const SCRIPT = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$ErrorActionPreference = "SilentlyContinue"',
    'while ($null -ne [Console]::In.ReadLine()) {',
    '  Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
    `  "${END}"`,
    '}',
].join('\n')

export function parseRows(text: string): ProcessRow[] {
    return text.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^(\d+) (\d+) (.+)$/)
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), name: match[3].trim() }] : []
    })
}

/** Every process below `pid`, deepest last. */
export function below(rows: readonly ProcessRow[], pid: number): number[] {
    const children = new Map<number, number[]>()
    for (const row of rows) {
        // Windows reuses ids and keeps a dead parent's id on its children: no loops.
        if (row.pid !== row.parent)
            children.set(row.parent, [...children.get(row.parent) ?? [], row.pid])
    }
    const out: number[] = []
    const seen = new Set([pid])
    const queue = [pid]
    while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
            if (seen.has(child))
                continue
            seen.add(child)
            out.push(child)
            queue.push(child)
        }
    }
    return out
}

/** The console hosts ConPTY attaches to every shell; they are not something the user runs. */
const HOSTS = new Set(['conhost.exe', 'openconsole.exe'])

/** What the shell `pid` runs: its newest child that is not a console host, as `ping` for PING.EXE ('' at the prompt). */
export function foregroundOf(rows: readonly ProcessRow[], pid: number): string {
    const child = rows.filter(r => r.parent === pid && r.pid !== pid && !HOSTS.has(r.name.toLowerCase())).at(-1)
    return child ? child.name.replace(/\.exe$/i, '').toLowerCase() : ''
}

let helper: ChildProcessWithoutNullStreams | undefined
let idle: NodeJS.Timeout | undefined
let pending: { resolve: (rows: ProcessRow[]) => void }[] = []
let buffer = ''
let inFlight: Promise<ProcessRow[]> | undefined
let last: { at: number, rows: ProcessRow[] } | undefined

function stop() {
    helper?.kill()
    helper = undefined
}

function start(): ChildProcessWithoutNullStreams {
    const system32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const child = spawn(path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let end = buffer.indexOf(END)
        while (end >= 0) {
            const rows = parseRows(buffer.slice(0, end))
            buffer = buffer.slice(end + END.length)
            pending.shift()?.resolve(rows)
            end = buffer.indexOf(END)
        }
    })
    const fail = () => {
        if (helper === child)
            helper = undefined
        buffer = ''
        const waiting = pending
        pending = []
        waiting.forEach(p => p.resolve([]))
    }
    child.on('exit', fail)
    child.on('error', fail)
    child.stdin.on('error', () => {})
    // The app does not wait for it to quit.
    child.unref()
    ;(child.stdout as any).unref?.()
    ;(child.stderr as any).unref?.()
    ;(child.stdin as any).unref?.()
    return child
}

/** All processes, from one WMI query (or the last one, when it is fresh); [] when WMI cannot be asked. */
export function processes(): Promise<ProcessRow[]> {
    if (last && Date.now() - last.at < FRESH_MS)
        return Promise.resolve(last.rows)
    inFlight ??= new Promise<ProcessRow[]>((resolve) => {
        helper ??= start()
        pending.push({ resolve })
        helper.stdin.write('\n')
    }).then((rows) => {
        inFlight = undefined
        last = { at: Date.now(), rows }
        return rows
    })
    clearTimeout(idle)
    idle = setTimeout(stop, IDLE_MS)
    idle.unref()
    return inFlight
}
