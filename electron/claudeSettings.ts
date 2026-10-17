// Claude Code's own settings the app shows: the MCP servers it has, and (with claude mcp add / remove, its
// own commands) the ones you change. Nothing is kept here; the files are Claude Code's, the terminal's
// `claude` reads the same. The user-level servers live in `.claude.json` (inside CLAUDE_CONFIG_DIR when set,
// else in the home folder), a project's own in `.claude.json` under `projects.<folder>` (local) and in the
// project's `.mcp.json` (project, for the team).
import type { ClaudeMcpAdd, ClaudeMcpRemove, ClaudeMcpServer } from '@shared/ipc'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { tr } from './i18n'

type Env = Record<string, string | undefined>

/** Where Claude Code keeps `.claude.json`: in CLAUDE_CONFIG_DIR when that is set, else in the home folder. */
export function claudeJsonPath(env: Env = process.env, home = os.homedir()): string {
    return path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')
}

async function readJson(file: string): Promise<Record<string, any>> {
    try {
        const value = JSON.parse(await readFile(file, 'utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }
    catch {
        return {}
    }
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function serversOf(table: unknown, scope: ClaudeMcpServer['scope']): ClaudeMcpServer[] {
    if (!isObject(table))
        return []
    return Object.entries(table).filter(([, spec]) => isObject(spec)).map(([name, spec]) => {
        const transport = typeof spec.type === 'string' ? spec.type : spec.url ? 'http' : 'stdio'
        const args = Array.isArray(spec.args) ? spec.args.filter((a: unknown) => typeof a === 'string') : []
        const target = typeof spec.url === 'string' ? spec.url : [spec.command, ...args].filter(a => typeof a === 'string' && a).join(' ')
        return { name, scope, transport, target }
    })
}

/** The servers Claude Code has for a project: its own (local), the team's `.mcp.json` (project), and yours everywhere (user). */
export async function claudeMcpServers(cwd: string, env: Env = process.env, home = os.homedir()): Promise<ClaudeMcpServer[]> {
    const json = await readJson(claudeJsonPath(env, home))
    const local = isObject(json.projects) && isObject(json.projects[cwd]) ? json.projects[cwd].mcpServers : undefined
    const project = (await readJson(path.join(cwd, '.mcp.json'))).mcpServers
    return [...serversOf(local, 'local'), ...serversOf(project, 'project'), ...serversOf(json.mcpServers, 'user')]
}

/** A command line as words: spaces separate them, single or double quotes keep a word together, a backslash escapes the next character. */
export function commandWords(line: string): string[] {
    const words: string[] = []
    let word = ''
    let quote = ''
    let started = false
    for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (quote) {
            if (c === quote)
                quote = ''
            else if (c === '\\' && quote === '"' && i + 1 < line.length)
                word += line[++i]
            else
                word += c
        }
        else if (c === '"' || c === '\'') {
            quote = c
            started = true
        }
        else if (c === '\\' && i + 1 < line.length) {
            word += line[++i]
            started = true
        }
        else if (c === ' ' || c === '\t') {
            if (word || started)
                words.push(word)
            word = ''
            started = false
        }
        else {
            word += c
        }
    }
    if (quote)
        throw new Error(tr('引号没有闭合', 'A quote is not closed'))
    if (word || started)
        words.push(word)
    return words
}

const SCOPES = ['local', 'project', 'user']
const TRANSPORTS = ['stdio', 'http', 'sse']
const NAME = /^\w[\w.-]*$/

/** The `claude mcp add` command for a server (checked first: this goes to a command, not a shell). */
export function mcpAddArgs(input: ClaudeMcpAdd): string[] {
    if (!SCOPES.includes(input.scope) || !TRANSPORTS.includes(input.transport))
        throw new Error('unknown scope or transport')
    if (!NAME.test(input.name))
        throw new Error(tr('名字以字母或数字开头，只能用字母、数字、点、下划线和连字符', 'The name starts with a letter or digit and has only letters, digits, dots, underscores and dashes'))
    const env = (input.env ?? []).map((line) => {
        const at = line.indexOf('=')
        if (at < 1)
            throw new Error(tr(`环境变量要写成 名字=值：${line}`, `An environment variable is NAME=value: ${line}`))
        return line
    })
    const head = ['mcp', 'add', '-s', input.scope]
    if (input.transport !== 'stdio') {
        if (!/^https?:\/\//.test(input.target))
            throw new Error(tr('地址要以 http:// 或 https:// 开头', 'The URL must start with http:// or https://'))
        return [...head, '--transport', input.transport, input.name, input.target]
    }
    const words = commandWords(input.target)
    if (!words.length)
        throw new Error(tr('命令不能为空', 'The command is empty'))
    // The name first, then -e (it takes any number of values), then -- and the server's command.
    return [...head, input.name, ...env.flatMap(e => ['-e', e]), '--', ...words]
}

export function mcpRemoveArgs(input: ClaudeMcpRemove): string[] {
    if (!SCOPES.includes(input.scope) || !NAME.test(input.name))
        throw new Error('unknown scope or name')
    return ['mcp', 'remove', '-s', input.scope, input.name]
}
