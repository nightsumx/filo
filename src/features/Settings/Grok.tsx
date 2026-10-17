// Settings → Grok Build: what its terminal commands /mcps and `grok mcp` do. The servers are the
// [mcp_servers.<name>] tables of ~/.grok/config.toml and the project's ./.grok/config.toml; everything goes
// through the user's own `grok mcp`, so the terminal's grok sees the same. Nothing is kept here.
import type { GrokMcpServer } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Comment, flatFieldClass, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { confirm } from '@/lib/confirm'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const AddForm = observer(({ cwd, onAdded }: { cwd: string, onAdded: (servers: GrokMcpServer[]) => void }) => {
    const [name, setName] = useState('')
    const [scope, setScope] = useState<GrokMcpServer['scope']>('user')
    const [transport, setTransport] = useState<GrokMcpServer['transport']>('stdio')
    const [target, setTarget] = useState('')
    const [env, setEnv] = useState('')
    const [busy, setBusy] = useState(false)
    const add = async () => {
        setBusy(true)
        try {
            const lines = transport === 'stdio' ? env.split('\n').map(l => l.trim()).filter(Boolean) : []
            onAdded(await window.pi.addGrokMcp({ cwd, name: name.trim(), scope, transport, target: target.trim(), env: lines }))
            setName('')
            setTarget('')
            setEnv('')
            toast.success(tr('已添加，新开的线程生效', 'Added. New threads use it'))
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
                placeholder={transport === 'stdio' ? tr('命令，例如 npx -y @modelcontextprotocol/server-filesystem .', 'Command, e.g. npx -y @modelcontextprotocol/server-filesystem .') : 'https://example.com/mcp'}
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
                <Segmented value={scope} options={[{ value: 'user', label: tr('所有项目', 'All projects') }, { value: 'project', label: tr('本项目', 'This project') }]} onChange={setScope} />
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
    const [servers, setServers] = useState<GrokMcpServer[]>()
    const [failed, setFailed] = useState('')
    useEffect(() => {
        if (cwd)
            void window.pi.grokMcp(cwd).then(setServers, (error: Error) => setFailed(error.message))
    }, [cwd])
    if (!cwd)
        return <Comment className="py-3">{tr('先打开一个项目。', 'Open a project first.')}</Comment>
    const run = async (work: () => Promise<GrokMcpServer[]>, failure: string) => {
        try {
            setServers(await work())
        }
        catch (error: any) {
            toast.error(failure, { description: error.message })
        }
    }
    const remove = async (server: GrokMcpServer) => {
        if (!await confirm({
            title: tr(`移除 ${server.name}？`, `Remove ${server.name}?`),
            description: tr('只移除 config.toml 里的这一条，不会卸载服务器本身。', 'This removes the entry from config.toml only; the server itself is not uninstalled.'),
            confirmText: tr('移除', 'Remove'),
        }))
            return
        await run(() => window.pi.removeGrokMcp(cwd, server.scope, server.name), tr('移除失败', 'Could not remove'))
    }
    return (
        <SettingRow
            title="MCP"
            description={tr(
                '给 Grok 接上的工具服务器，和终端里的 /mcps、grok mcp 是同一份（config.toml 的 [mcp_servers]）。',
                'Tool servers connected to Grok, the same as /mcps and grok mcp in the terminal (the [mcp_servers] tables of config.toml).',
            )}
            control={() => <span className="text-[12px] tabular-nums text-[var(--jb-comment)]">{servers ? servers.length : ''}</span>}
        >
            {failed && <Comment className="mt-2">{failed}</Comment>}
            {servers?.length === 0 && <Comment className="mt-2">{tr('还没有 MCP 服务器。', 'No MCP servers yet.')}</Comment>}
            <ul className="mt-2 flex flex-col gap-1" data-mcp-list>
                {servers?.map(server => (
                    <li key={`${server.scope}:${server.name}`} className="flex flex-col gap-1 rounded-[6px] bg-[var(--jb-fill)] px-3 py-2 text-[13px]" data-mcp={server.name} data-scope={server.scope}>
                        <div className="flex items-center gap-2">
                            <Switch checked={server.enabled} onChange={enabled => void run(() => window.pi.setGrokMcp(cwd, server.name, enabled), tr('保存失败', 'Could not save'))} labelledBy={`grok-mcp-${server.scope}-${server.name}`} />
                            <span id={`grok-mcp-${server.scope}-${server.name}`} className="font-medium text-gray-900">{server.name}</span>
                            <span className="shrink-0 text-[11px] text-[var(--jb-comment)]">
                                {[server.scope === 'project' ? tr('本项目', 'This project') : tr('所有项目', 'All projects'), server.transport].join(' · ')}
                            </span>
                            <span className="flex-1" />
                            <Button variant="outline" size="sm" onClick={() => void remove(server)}>{tr('移除', 'Remove')}</Button>
                        </div>
                        <span className="truncate pl-11 font-mono text-[12px] text-gray-600" title={server.target}>{server.target}</span>
                    </li>
                ))}
            </ul>
            <AddForm cwd={cwd} onAdded={setServers} />
        </SettingRow>
    )
})

export const GrokPage = observer(() => (
    <SettingsPage title="Grok Build">
        <McpSection />
    </SettingsPage>
))
