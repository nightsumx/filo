// pi's MCP servers (its /mcp and `pi mcp`), since pi 1.0.4: `mcp.json` in the agent folder (yours) and
// `.pi/mcp.json` in a project (only read once the project is trusted). Listing and the on/off switch read and
// write those files as /mcp does, keeping every other key; adding and removing run the user's own `pi mcp`.
import type { PiMcpAdd, PiMcpServer } from '@shared/ipc'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { codexServerName, commandWords } from './claudeSettings'
import { tr } from './i18n'
import { agentDir } from './piSettings'

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const SCOPES = ['user', 'project']
const EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden']

const fileOf = (scope: string, cwd: string) => scope === 'project' ? path.join(cwd, '.pi', 'mcp.json') : path.join(agentDir(), 'mcp.json')

async function readJson(file: string): Promise<Record<string, any>> {
    try {
        const value = JSON.parse(await readFile(file, 'utf8'))
        return isObject(value) ? value : {}
    }
    catch {
        return {}
    }
}

function serversOf(table: unknown, scope: PiMcpServer['scope']): PiMcpServer[] {
    if (!isObject(table))
        return []
    return Object.entries(table as Record<string, any>).filter(([, spec]) => isObject(spec)).map(([name, spec]) => {
        const args = Array.isArray(spec.args) ? spec.args.filter((a: unknown) => typeof a === 'string') : []
        const url = typeof spec.url === 'string' ? spec.url : undefined
        const command = typeof spec.command === 'string' ? spec.command : undefined
        return {
            name,
            scope,
            // An entry with no command or url in a project only switches a user-level server on or off there.
            transport: url ? 'http' : command ? 'stdio' : 'override',
            target: url ?? [command, ...args].filter(Boolean).join(' '),
            enabled: spec.enabled !== false,
            exposure: typeof spec.exposure === 'string' ? spec.exposure : 'codemode',
        }
    })
}

/** The servers in the project's `.pi/mcp.json` (project) and in yours (user). */
export async function piMcpServers(cwd: string): Promise<PiMcpServer[]> {
    const [project, user] = await Promise.all([readJson(fileOf('project', cwd)), readJson(fileOf('user', cwd))])
    return [...serversOf(project.mcpServers, 'project'), ...serversOf(user.mcpServers, 'user')]
}

/** The `pi mcp add` arguments (checked first: they go to a command, not a shell). */
export function piMcpAddArgs(input: PiMcpAdd): string[] {
    codexServerName(input.name)
    if (!SCOPES.includes(input.scope))
        throw new Error('unknown scope')
    const head = ['mcp', 'add', ...(input.scope === 'project' ? ['--local'] : []), input.name]
    if (input.transport === 'http') {
        if (!/^https?:\/\//.test(input.target))
            throw new Error(tr('地址要以 http:// 或 https:// 开头', 'The URL must start with http:// or https://'))
        return [...head, '--url', input.target]
    }
    if (input.transport !== 'stdio')
        throw new Error('unknown transport')
    const words = commandWords(input.target)
    if (!words.length)
        throw new Error(tr('命令不能为空', 'The command is empty'))
    const env = (input.env ?? []).flatMap((line) => {
        if (line.indexOf('=') < 1)
            throw new Error(tr(`环境变量要写成 名字=值：${line}`, `An environment variable is NAME=value: ${line}`))
        return ['--env', line]
    })
    return [...head, ...env, '--', ...words]
}

export function piMcpRemoveArgs(scope: string, name: string): string[] {
    codexServerName(name)
    if (!SCOPES.includes(scope))
        throw new Error('unknown scope')
    return ['mcp', 'remove', ...(scope === 'project' ? ['--local'] : []), name]
}

/** `enabled` and `exposure` of one server, written into the file that defines it; nothing else in the file changes. */
export async function setPiMcp(cwd: string, scope: string, name: string, patch: { enabled?: unknown, exposure?: unknown }): Promise<void> {
    codexServerName(name)
    if (!SCOPES.includes(scope))
        throw new Error('unknown scope')
    const file = fileOf(scope, cwd)
    const json = await readJson(file)
    const spec = isObject(json.mcpServers) ? json.mcpServers[name] : undefined
    if (!isObject(spec))
        throw new Error(tr(`${name} 不在 ${file} 里`, `${name} is not in ${file}`))
    const next = { ...spec }
    if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean')
            throw new Error('expected true or false')
        // On is the default: the key goes away rather than saying true.
        if (patch.enabled)
            delete next.enabled
        else
            next.enabled = false
    }
    if (patch.exposure !== undefined) {
        if (typeof patch.exposure !== 'string' || !EXPOSURES.includes(patch.exposure))
            throw new Error('unknown exposure')
        // codemode is the default too.
        if (patch.exposure === 'codemode')
            delete next.exposure
        else
            next.exposure = patch.exposure
    }
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify({ ...json, mcpServers: { ...json.mcpServers, [name]: next } }, null, 2)}\n`)
    await rename(tmp, file)
}
