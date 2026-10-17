// Settings → Claude Code: what its terminal commands /mcp (and more, below) do. Everything is Claude Code's
// own: the servers are in its .claude.json and the project's .mcp.json, changed with `claude mcp add` and
// `claude mcp remove` (the user's own claude), so the terminal's `claude` sees the same. Nothing is kept here.
import type { ClaudeMcpServer } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Comment, flatFieldClass, Segmented, SettingRow, SettingsPage } from '@/components/ui/form'
import { confirm } from '@/lib/confirm'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const SCOPE_LABEL = {
    local: { zh: '本项目（仅你）', en: 'This project (you)' },
    project: { zh: '本项目（团队，.mcp.json）', en: 'This project (team, .mcp.json)' },
    user: { zh: '所有项目', en: 'All projects' },
}

type Scope = ClaudeMcpServer['scope']
type Transport = 'stdio' | 'http' | 'sse'

const McpAddForm = observer(({ cwd, onAdded }: { cwd: string, onAdded: (servers: ClaudeMcpServer[]) => void }) => {
    const [name, setName] = useState('')
    const [scope, setScope] = useState<Scope>('local')
    const [transport, setTransport] = useState<Transport>('stdio')
    const [target, setTarget] = useState('')
    const [env, setEnv] = useState('')
    const [busy, setBusy] = useState(false)
    const add = async () => {
        setBusy(true)
        try {
            const lines = transport === 'stdio' ? env.split('\n').map(l => l.trim()).filter(Boolean) : []
            onAdded(await window.pi.addClaudeMcp({ cwd, name: name.trim(), scope, transport, target: target.trim(), env: lines }))
            setName('')
            setTarget('')
            setEnv('')
            toast.success(tr('已添加，新开的线程生效；已在运行的线程要重开才会加载', 'Added. New threads load it; a running thread needs to be reopened'))
        }
        catch (error: any) {
            toast.error(tr('添加失败', 'Could not add'), { description: error.message })
        }
        finally {
            setBusy(false)
        }
    }
    return (
        <div className="flex flex-col gap-2.5 pt-3" data-mcp-form>
            <div className="flex items-center gap-2">
                <input aria-label={tr('名字', 'Name')} placeholder={tr('名字', 'Name')} value={name} onChange={e => setName(e.target.value)} className={`${flatFieldClass} w-40`} />
                <Segmented
                    value={transport}
                    options={[{ value: 'stdio', label: tr('本地命令', 'Command') }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }]}
                    onChange={setTransport}
                />
            </div>
            <input
                aria-label={transport === 'stdio' ? tr('命令', 'Command') : 'URL'}
                placeholder={transport === 'stdio' ? tr('命令，例如 npx -y @modelcontextprotocol/server-filesystem /tmp', 'Command, e.g. npx -y @modelcontextprotocol/server-filesystem /tmp') : 'https://example.com/mcp'}
                value={target}
                onChange={e => setTarget(e.target.value)}
                className={`${flatFieldClass} font-mono`}
            />
            {transport === 'stdio' && (
                <textarea
                    aria-label={tr('环境变量', 'Environment variables')}
                    placeholder={tr('环境变量，每行一个：名字=值（可不填）', 'Environment variables, one per line: NAME=value (optional)')}
                    value={env}
                    onChange={e => setEnv(e.target.value)}
                    rows={2}
                    className={`${flatFieldClass} h-auto py-1.5 font-mono`}
                />
            )}
            <div className="flex items-center gap-3">
                <Segmented value={scope} options={(['local', 'project', 'user'] as const).map(value => ({ value, label: tr(SCOPE_LABEL[value]) }))} onChange={setScope} />
                <Button variant="outline" size="sm" className="ml-auto" disabled={busy || !name.trim() || !target.trim()} onClick={() => void add()}>
                    {busy && <Loader2 size={12} className="mr-1 animate-spin" />}
                    {tr('添加', 'Add')}
                </Button>
            </div>
        </div>
    )
})

const McpSection = observer(() => {
    const cwd = appStore.project?.cwd
    const [servers, setServers] = useState<ClaudeMcpServer[]>()
    useEffect(() => {
        if (cwd)
            void window.pi.claudeMcp(cwd).then(setServers, () => setServers([]))
    }, [cwd])
    if (!cwd)
        return <Comment className="py-3">{tr('先打开一个项目。', 'Open a project first.')}</Comment>
    const remove = async (server: ClaudeMcpServer) => {
        if (!await confirm({
            title: tr(`移除 ${server.name}？`, `Remove ${server.name}?`),
            description: tr('只移除这条配置，不会卸载服务器本身。', 'This removes the entry only; the server itself is not uninstalled.'),
            confirmText: tr('移除', 'Remove'),
        }))
            return
        try {
            setServers(await window.pi.removeClaudeMcp({ cwd, name: server.name, scope: server.scope }))
        }
        catch (error: any) {
            toast.error(tr('移除失败', 'Could not remove'), { description: error.message })
        }
    }
    return (
        <SettingRow
            title="MCP"
            description={tr(
                '给 Claude Code 接上的工具服务器，和终端里的 /mcp、claude mcp 是同一份。团队的 .mcp.json 要先在终端里批准才会加载。',
                'Tool servers connected to Claude Code, the same as /mcp and claude mcp in the terminal. A team\'s .mcp.json has to be approved in the terminal before it loads.',
            )}
            control={() => <span className="text-[12px] tabular-nums text-[var(--jb-comment)]">{servers ? servers.length : ''}</span>}
        >
            {servers?.length === 0 && <Comment className="mt-2">{tr('还没有 MCP 服务器。', 'No MCP servers yet.')}</Comment>}
            <ul className="mt-2 flex flex-col gap-1" data-mcp-list>
                {servers?.map(server => (
                    <li key={`${server.scope}:${server.name}`} className="flex items-center gap-2 rounded-[6px] bg-[var(--jb-fill)] px-3 py-1.5 text-[13px]" data-mcp={server.name}>
                        <span className="font-medium text-gray-900">{server.name}</span>
                        <span className="shrink-0 text-[11px] text-[var(--jb-comment)]">{`${tr(SCOPE_LABEL[server.scope])} · ${server.transport}`}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-600" title={server.target}>{server.target}</span>
                        <Button variant="outline" size="sm" onClick={() => void remove(server)}>{tr('移除', 'Remove')}</Button>
                    </li>
                ))}
            </ul>
            <McpAddForm cwd={cwd} onAdded={setServers} />
        </SettingRow>
    )
})

export const ClaudeCodePage = observer(() => (
    <SettingsPage title="Claude Code">
        <McpSection />
    </SettingsPage>
))
