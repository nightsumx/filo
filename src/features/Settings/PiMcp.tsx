// pi's MCP servers (its /mcp and `pi mcp`), since pi 1.0.4. They live in pi's own files: mcp.json in the
// agent folder (yours) and .pi/mcp.json in the project (read only once the project is trusted). Adding and
// removing run the user's own `pi mcp`; the switch and exposure edit the file that defines the server.
import type { PiMcpServer } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Comment, flatFieldClass, Segmented, SettingRow, Switch } from '@/components/ui/form'
import { confirm } from '@/lib/confirm'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const EXPOSURES = [
    { value: 'codemode', label: { zh: '脚本里调用', en: 'From codemode' } },
    { value: 'deferred', label: { zh: '搜到才加载', en: 'After tool search' } },
    { value: 'direct', label: { zh: '直接给模型', en: 'Direct to the model' } },
    { value: 'hidden', label: { zh: '隐藏', en: 'Hidden' } },
]

const AddForm = observer(({ cwd, onAdded }: { cwd: string, onAdded: (servers: PiMcpServer[]) => void }) => {
    const [name, setName] = useState('')
    const [scope, setScope] = useState<PiMcpServer['scope']>('user')
    const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
    const [target, setTarget] = useState('')
    const [env, setEnv] = useState('')
    const [busy, setBusy] = useState(false)
    const add = async () => {
        setBusy(true)
        try {
            const lines = transport === 'stdio' ? env.split('\n').map(l => l.trim()).filter(Boolean) : []
            onAdded(await window.pi.addPiMcp({ cwd, name: name.trim(), scope, transport, target: target.trim(), env: lines }))
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
                <Segmented value={transport} options={[{ value: 'stdio', label: tr('本地命令', 'Command') }, { value: 'http', label: 'HTTP' }]} onChange={setTransport} />
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

export const PiMcpSection = observer(() => {
    const cwd = appStore.project?.cwd
    const [servers, setServers] = useState<PiMcpServer[]>()
    const [trusted, setTrusted] = useState(true)
    useEffect(() => {
        if (!cwd)
            return
        void window.pi.piMcp(cwd).then(setServers, () => setServers([]))
        void window.pi.projectTrust([cwd]).then(([t]) => setTrusted(t ? (t.decision ?? t.fallback === 'always') : true), () => {})
    }, [cwd])
    if (!cwd)
        return null
    const run = async (work: () => Promise<PiMcpServer[]>, failure: string) => {
        try {
            setServers(await work())
        }
        catch (error: any) {
            toast.error(failure, { description: error.message })
        }
    }
    const remove = async (server: PiMcpServer) => {
        if (!await confirm({
            title: tr(`移除 ${server.name}？`, `Remove ${server.name}?`),
            description: tr('只移除 mcp.json 里的这一条，不会卸载服务器本身。', 'This removes the entry from mcp.json only; the server itself is not uninstalled.'),
            confirmText: tr('移除', 'Remove'),
        }))
            return
        await run(() => window.pi.removePiMcp(cwd, server.scope, server.name), tr('移除失败', 'Could not remove'))
    }
    const hasProject = servers?.some(s => s.scope === 'project')
    return (
        <SettingRow
            title="MCP"
            description={tr(
                'pi 接上的工具服务器，和终端里的 /mcp、pi mcp 是同一份（mcp.json）。需要登录的远程服务器，在终端里 pi mcp login。',
                'Tool servers connected to pi, the same as /mcp and pi mcp in the terminal (mcp.json). A remote server that needs sign-in: pi mcp login in the terminal.',
            )}
            control={() => <span className="text-[12px] tabular-nums text-[var(--jb-comment)]">{servers ? servers.length : ''}</span>}
        >
            {hasProject && !trusted && <Comment className="mt-2" id="pi-mcp-untrusted">{tr('这个项目还没被信任，它自己的 .pi/mcp.json 不会加载（设置 → 项目信任）。', 'This project is not trusted, so its own .pi/mcp.json is not loaded (Settings → Project trust).')}</Comment>}
            {servers?.length === 0 && <Comment className="mt-2">{tr('还没有 MCP 服务器。', 'No MCP servers yet.')}</Comment>}
            <ul className="mt-2 flex flex-col gap-1" data-mcp-list>
                {servers?.map(server => (
                    <li key={`${server.scope}:${server.name}`} className="flex flex-col gap-1 rounded-[6px] bg-[var(--jb-fill)] px-3 py-2 text-[13px]" data-mcp={server.name} data-scope={server.scope}>
                        <div className="flex items-center gap-2">
                            <Switch checked={server.enabled} onChange={enabled => void run(() => window.pi.setPiMcp(cwd, server.scope, server.name, { enabled }), tr('保存失败', 'Could not save'))} labelledBy={`pi-mcp-${server.scope}-${server.name}`} />
                            <span id={`pi-mcp-${server.scope}-${server.name}`} className="font-medium text-gray-900">{server.name}</span>
                            <span className="shrink-0 text-[11px] text-[var(--jb-comment)]">
                                {[server.scope === 'project' ? tr('本项目', 'This project') : tr('所有项目', 'All projects'), server.transport === 'override' ? tr('只改开关', 'on/off only') : server.transport].join(' · ')}
                            </span>
                            <span className="flex-1" />
                            {server.transport !== 'override' && (
                                <select
                                    aria-label={tr('工具怎么给模型', 'How tools reach the model')}
                                    value={server.exposure}
                                    onChange={e => void run(() => window.pi.setPiMcp(cwd, server.scope, server.name, { exposure: e.target.value }), tr('保存失败', 'Could not save'))}
                                    className={`${flatFieldClass} h-7 w-auto py-0 text-[12px]`}
                                >
                                    {EXPOSURES.map(e => <option key={e.value} value={e.value}>{tr(e.label)}</option>)}
                                </select>
                            )}
                            <Button variant="outline" size="sm" onClick={() => void remove(server)}>{tr('移除', 'Remove')}</Button>
                        </div>
                        {server.target && <span className="truncate pl-11 font-mono text-[12px] text-gray-600" title={server.target}>{server.target}</span>}
                    </li>
                ))}
            </ul>
            <AddForm cwd={cwd} onAdded={setServers} />
        </SettingRow>
    )
})
