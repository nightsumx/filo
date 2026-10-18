// Grok Build's MCP servers (its /mcps and `grok mcp`): the [mcp_servers.<name>] tables of ~/.grok/config.toml
// (user) and ./.grok/config.toml (project). Everything goes through the user's own `grok mcp`, which reads and
// writes those files, so the terminal's grok sees the same. `grok mcp list --json` reads files only.
import type { GrokMcpAdd, GrokMcpServer } from '@shared/ipc'
import { codexServerName, commandLine, commandWords } from './claudeSettings'
import { tr } from './i18n'

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const SCOPES = ['user', 'project']

/** What `grok mcp list --json` printed, as the list the settings page shows. */
export function parseGrokMcp(output: string): GrokMcpServer[] {
    let list: unknown
    try {
        list = JSON.parse(output)
    }
    catch {
        return []
    }
    if (!Array.isArray(list))
        return []
    return list.filter(isObject).filter(item => typeof item.name === 'string').map((item): GrokMcpServer => {
        const url = typeof item.url === 'string' ? item.url : undefined
        const args = Array.isArray(item.args) ? item.args.filter((a: unknown) => typeof a === 'string') : []
        return {
            name: item.name,
            scope: item.scope === 'project' ? 'project' : 'user',
            transport: item.type === 'sse' ? 'sse' : url ? 'http' : 'stdio',
            target: url ?? commandLine([item.command, ...args].filter(a => typeof a === 'string' && a)),
            enabled: item.enabled !== false,
        }
    })
}

export const GROK_MCP_LIST = ['mcp', 'list', '--json']

/** The `grok mcp add` command (checked first: it goes to a command, not a shell). */
export function grokMcpAddArgs(input: GrokMcpAdd): string[] {
    codexServerName(input.name)
    if (!SCOPES.includes(input.scope))
        throw new Error('unknown scope')
    const head = ['mcp', 'add', '-s', input.scope]
    if (input.transport === 'http' || input.transport === 'sse') {
        if (!/^https?:\/\//.test(input.target))
            throw new Error(tr('地址要以 http:// 或 https:// 开头', 'The URL must start with http:// or https://'))
        return [...head, '-t', input.transport, input.name, input.target]
    }
    if (input.transport !== 'stdio')
        throw new Error('unknown transport')
    const words = commandWords(input.target)
    if (!words.length)
        throw new Error(tr('命令不能为空', 'The command is empty'))
    const env = (input.env ?? []).flatMap((line) => {
        if (line.indexOf('=') < 1)
            throw new Error(tr(`环境变量要写成 名字=值：${line}`, `An environment variable is NAME=value: ${line}`))
        return ['-e', line]
    })
    // Options first; after `--` the command and its own arguments, so a flag like -y reaches the server.
    return [...head, ...env, input.name, '--', ...words]
}

export function grokMcpRemoveArgs(scope: string, name: string): string[] {
    codexServerName(name)
    if (!SCOPES.includes(scope))
        throw new Error('unknown scope')
    return ['mcp', 'remove', '-s', scope, name]
}

/** Enabling and disabling take the name only: grok finds the scope itself. */
export function grokMcpEnableArgs(name: string, enabled: unknown): string[] {
    codexServerName(name)
    if (typeof enabled !== 'boolean')
        throw new Error('expected true or false')
    return ['mcp', enabled ? 'enable' : 'disable', name]
}
