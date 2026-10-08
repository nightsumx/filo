// Tool call wording for the transcript (titles, one-line summaries, Input bodies), following
// pi-cc-extensions, plus the path → highlight.js language map shared by code blocks and diffs.
import { insideOf, isAbsolutePath, pathParts } from '../platform'

export function basename(path: string): string {
    const parts = pathParts(path)
    return parts[parts.length - 1] || path
}

/** Tool name as pi's TUI prints it: bash → Bash, web_search → Web Search. */
export function tuiTitle(name: string): string {
    if (name.toLowerCase() === 'ls')
        return 'Ls'
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
}

/** Absolute paths inside cwd become relative, like the TUI. */
export function displayPath(path: string, cwd?: string): string {
    if (!cwd || !isAbsolutePath(path))
        return path
    if (path === cwd)
        return '.'
    return insideOf(path, cwd) ?? path
}

function oneLine(s: string): string {
    return s.split('\n').join(' ').replace(/\s+/g, ' ').trim()
}

const GENERIC_FIELDS = ['command', 'query', 'url', 'name', 'id', 'message', 'description', 'prompt']

/**
 * Call line after the title, following pi-cc-extensions' names.ts: the command for bash,
 * `"pattern" in path` for searches, the path (+ offset/limit) for file tools.
 */
export function tuiSummary(name: string, args: Record<string, unknown> | undefined, cwd?: string): { main: string, detail: string } {
    const a = args ?? {}
    const str = (k: string) => (typeof a[k] === 'string' && a[k] ? a[k] as string : undefined)
    const path = str('path') ?? str('file_path')
    if (name === 'read') {
        const parts = [a.offset != null ? `offset=${a.offset}` : '', a.limit != null ? `limit=${a.limit}` : ''].filter(Boolean)
        return { main: path ? displayPath(path, cwd) : '', detail: parts.length ? ` (${parts.join(', ')})` : '' }
    }
    if (typeof a.pattern === 'string' || name === 'grep' || name === 'find') {
        const scope = path ? ` in ${displayPath(path, cwd)}` : ''
        return { main: `${JSON.stringify(oneLine(String(a.pattern ?? '…')))}${scope}`, detail: '' }
    }
    for (const key of GENERIC_FIELDS) {
        const v = str(key)
        if (v)
            return { main: oneLine(v), detail: '' }
    }
    if (path)
        return { main: displayPath(path, cwd), detail: '' }
    const keys = Object.keys(a)
    return { main: keys.length ? oneLine(JSON.stringify(a)) : '', detail: '' }
}

/** Input section body: `key: value` lines in a human-first order (pi-cc-extensions formatToolInputBody). */
export function formatToolInput(args: Record<string, unknown> | undefined): string {
    const preferred = ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'name', 'message', 'content']
    const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined)
    entries.sort(([l], [r]) => {
        const li = preferred.indexOf(l)
        const ri = preferred.indexOf(r)
        if (li === -1 && ri === -1)
            return l.localeCompare(r)
        if (li === -1)
            return 1
        if (ri === -1)
            return -1
        return li - ri
    })
    const lines: string[] = []
    for (const [key, value] of entries) {
        if (typeof value === 'string') {
            if (value.includes('\n')) {
                lines.push(`${key}:`)
                for (const line of value.split('\n'))
                    lines.push(`  ${line}`)
            }
            else {
                lines.push(`${key}: ${value}`)
            }
            continue
        }
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
            lines.push(`${key}: ${String(value)}`)
            continue
        }
        const json = JSON.stringify(value, null, 2) ?? ''
        if (json.includes('\n')) {
            lines.push(`${key}:`)
            for (const line of json.split('\n'))
                lines.push(`  ${line}`)
        }
        else {
            lines.push(`${key}: ${json}`)
        }
    }
    return lines.join('\n')
}

const langByExt: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    jsonl: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    xml: 'xml',
    html: 'xml',
    vue: 'xml',
    svg: 'xml',
    css: 'css',
    scss: 'scss',
    less: 'less',
    sql: 'sql',
    md: 'markdown',
    markdown: 'markdown',
    dockerfile: 'dockerfile',
}

/** highlight.js language id for a path (shared by code blocks and diffs). */
export function langOf(path: string): string {
    const name = basename(path).toLowerCase()
    if (name === 'dockerfile')
        return 'dockerfile'
    const ext = name.includes('.') ? name.split('.').pop()! : ''
    return langByExt[ext] ?? 'plaintext'
}
