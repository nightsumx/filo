// Settings → Codex: what its terminal commands /mcp and /experimental do. Everything is Codex's own: the
// servers and features are tables in its config.toml (written through its app-server's config/batchWrite),
// so the terminal's `codex` sees the same. Nothing is kept here.
import type { CodexFeature, CodexMcpServer, CodexPluginChange, CodexPlugins } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Comment, flatFieldClass, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { confirm } from '@/lib/confirm'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const McpAddForm = observer(({ cwd, onAdded }: { cwd: string, onAdded: (servers: CodexMcpServer[]) => void }) => {
    const [name, setName] = useState('')
    const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
    const [target, setTarget] = useState('')
    const [env, setEnv] = useState('')
    const [busy, setBusy] = useState(false)
    const add = async () => {
        setBusy(true)
        try {
            const lines = transport === 'stdio' ? env.split('\n').map(l => l.trim()).filter(Boolean) : []
            onAdded(await window.pi.addCodexMcp({ cwd, name: name.trim(), transport, target: target.trim(), env: lines }))
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
            <div className="flex justify-end">
                <Button variant="outline" size="sm" disabled={busy || !name.trim() || !target.trim()} onClick={() => void add()}>
                    {busy && <Loader2 size={12} className="mr-1 animate-spin" />}
                    {tr('添加', 'Add')}
                </Button>
            </div>
        </div>
    )
})

const McpSection = observer(() => {
    const cwd = appStore.project?.cwd
    const [servers, setServers] = useState<CodexMcpServer[]>()
    const [failed, setFailed] = useState('')
    useEffect(() => {
        if (cwd)
            void window.pi.codexMcp(cwd).then(setServers, (error: Error) => setFailed(error.message))
    }, [cwd])
    if (!cwd)
        return <Comment className="py-3">{tr('先打开一个项目。', 'Open a project first.')}</Comment>
    const remove = async (server: CodexMcpServer) => {
        if (!await confirm({
            title: tr(`移除 ${server.name}？`, `Remove ${server.name}?`),
            description: tr('只移除 config.toml 里的这一条，不会卸载服务器本身。', 'This removes the entry from config.toml only; the server itself is not uninstalled.'),
            confirmText: tr('移除', 'Remove'),
        }))
            return
        try {
            setServers(await window.pi.removeCodexMcp(cwd, server.name))
        }
        catch (error: any) {
            toast.error(tr('移除失败', 'Could not remove'), { description: error.message })
        }
    }
    return (
        <SettingRow
            title="MCP"
            description={tr(
                '给 Codex 接上的工具服务器，和终端里的 /mcp、codex mcp 是同一份（config.toml 的 [mcp_servers]）。',
                'Tool servers connected to Codex, the same as /mcp and codex mcp in the terminal (the [mcp_servers] tables of config.toml).',
            )}
            control={() => <span className="text-[12px] tabular-nums text-[var(--jb-comment)]">{servers ? servers.length : ''}</span>}
        >
            {failed && <Comment className="mt-2">{failed}</Comment>}
            {servers?.length === 0 && <Comment className="mt-2">{tr('还没有 MCP 服务器。', 'No MCP servers yet.')}</Comment>}
            <ul className="mt-2 flex flex-col gap-1" data-mcp-list>
                {servers?.map(server => (
                    <li key={server.name} className="flex flex-col gap-0.5 rounded-[6px] bg-[var(--jb-fill)] px-3 py-1.5 text-[13px]" data-mcp={server.name}>
                        <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-900">{server.name}</span>
                            <span className="shrink-0 text-[11px] text-[var(--jb-comment)]">
                                {[server.transport, server.enabled ? '' : tr('已停用', 'disabled'), server.tools ? tr(`${server.tools} 个工具`, `${server.tools} tools`) : ''].filter(Boolean).join(' · ')}
                            </span>
                            <span className="flex-1" />
                            <Button variant="outline" size="sm" onClick={() => void remove(server)}>{tr('移除', 'Remove')}</Button>
                        </div>
                        <span className="truncate font-mono text-[12px] text-gray-600" title={server.target}>{server.target}</span>
                        {server.error && <span className="truncate text-[11px] text-red-500" title={server.error} data-mcp-error>{server.error}</span>}
                    </li>
                ))}
            </ul>
            <McpAddForm cwd={cwd} onAdded={setServers} />
        </SettingRow>
    )
})

const FeaturesSection = observer(() => {
    const [features, setFeatures] = useState<CodexFeature[]>()
    useEffect(() => {
        void window.pi.codexFeatures().then(setFeatures, () => setFeatures([]))
    }, [])
    if (!features?.length)
        return null
    const toggle = async (feature: CodexFeature, enabled: boolean) => {
        try {
            setFeatures(await window.pi.setCodexFeature(feature.name, enabled))
        }
        catch (error: any) {
            toast.error(tr('保存失败', 'Could not save'), { description: error.message })
        }
    }
    return (
        <>
            <Comment className="px-0.5 pt-3">{tr('实验功能（Codex 的 /experimental）。新开的线程生效。', 'Experimental features (Codex\'s /experimental). New threads use them.')}</Comment>
            {features.map(feature => (
                <SettingRow
                    key={feature.name}
                    title={feature.title}
                    description={feature.description}
                    control={({ labelId, descId }) => <span data-feature={feature.name}><Switch checked={feature.enabled} labelledBy={labelId} describedBy={descId} onChange={v => void toggle(feature, v)} /></span>}
                />
            ))}
        </>
    )
})

const PluginsSection = observer(() => {
    const cwd = appStore.project?.cwd
    const [plugins, setPlugins] = useState<CodexPlugins>()
    const [failed, setFailed] = useState('')
    const [source, setSource] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => {
        if (cwd)
            void window.pi.codexPlugins(cwd).then(setPlugins, (error: Error) => setFailed(error.message))
    }, [cwd])
    if (!cwd)
        return null
    const change = async (action: CodexPluginChange, failure: string) => {
        setBusy(true)
        try {
            setPlugins(await window.pi.changeCodexPlugins(cwd, action))
            return true
        }
        catch (error: any) {
            toast.error(failure, { description: error.message })
            return false
        }
        finally {
            setBusy(false)
        }
    }
    const removeMarketplace = async (name: string) => {
        if (!await confirm({
            title: tr(`移除插件源 ${name}？`, `Remove the marketplace ${name}?`),
            description: tr('它的插件不再出现在列表里；已安装的插件要先卸载。', 'Its plugins no longer appear in the list; uninstall installed ones first.'),
            confirmText: tr('移除', 'Remove'),
        }))
            return
        await change({ action: 'removeMarketplace', name }, tr('移除失败', 'Could not remove'))
    }
    return (
        <SettingRow
            title={tr('插件', 'Plugins')}
            description={tr(
                '来自插件源（marketplace）的插件，带技能、MCP 服务器和应用，和终端里的 /plugins 是同一份。新开的线程生效。',
                'Plugins from marketplaces, bundling skills, MCP servers and apps, the same as /plugins in the terminal. New threads use them.',
            )}
            control={() => busy ? <Loader2 size={14} className="animate-spin text-[var(--jb-comment)]" /> : null}
        >
            {failed && <Comment className="mt-2">{failed}</Comment>}
            {plugins?.errors.map(message => <Comment key={message} className="mt-2 text-red-500">{message}</Comment>)}
            {plugins?.marketplaces.length === 0 && <Comment className="mt-2">{tr('还没有插件源。', 'No marketplaces yet.')}</Comment>}
            <div className="mt-2 flex flex-col gap-3" data-plugins>
                {plugins?.marketplaces.map(marketplace => (
                    <div key={marketplace.name} data-marketplace={marketplace.name}>
                        <div className="flex items-center gap-2 pb-1">
                            <span className="text-[12px] font-medium text-gray-700">{marketplace.name}</span>
                            <span className="flex-1" />
                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removeMarketplace(marketplace.name)}>{tr('移除插件源', 'Remove marketplace')}</Button>
                        </div>
                        <ul className="flex flex-col gap-1">
                            {marketplace.plugins.length === 0 && <Comment>{tr('这个插件源里没有插件。', 'No plugins in this marketplace.')}</Comment>}
                            {marketplace.plugins.map(plugin => (
                                <li key={plugin.id} className="flex flex-col gap-0.5 rounded-[6px] bg-[var(--jb-fill)] px-3 py-2 text-[13px]" data-plugin={plugin.id}>
                                    <div className="flex items-center gap-2">
                                        {plugin.installed && /^[\w-]+@[\w-]+$/.test(plugin.id) && (
                                            <Switch checked={plugin.enabled} onChange={enabled => void change({ action: 'enable', id: plugin.id, enabled }, tr('保存失败', 'Could not save'))} labelledBy={`plugin-${plugin.id}`} />
                                        )}
                                        <span id={`plugin-${plugin.id}`} className="font-medium text-gray-900">{plugin.name}</span>
                                        {plugin.version && <span className="shrink-0 text-[11px] text-[var(--jb-comment)]">{plugin.version}</span>}
                                        <span className="flex-1" />
                                        {plugin.installed
                                            ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void change({ action: 'uninstall', id: plugin.id }, tr('卸载失败', 'Could not uninstall'))}>{tr('卸载', 'Uninstall')}</Button>
                                            : (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={busy || !plugin.available || !marketplace.path}
                                                        onClick={() => void change({ action: 'install', marketplacePath: marketplace.path!, name: plugin.id.slice(0, plugin.id.lastIndexOf('@')) }, tr('安装失败', 'Could not install'))}
                                                    >
                                                        {tr('安装', 'Install')}
                                                    </Button>
                                                )}
                                    </div>
                                    {plugin.description && <span className="text-[12px] text-gray-600">{plugin.description}</span>}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>
            <div className="flex items-center gap-2 pt-3" data-marketplace-form>
                <input
                    aria-label={tr('插件源', 'Marketplace source')}
                    placeholder={tr('添加插件源：owner/repo、Git 地址或本地目录', 'Add a marketplace: owner/repo, a Git URL or a local folder')}
                    value={source}
                    onChange={e => setSource(e.target.value)}
                    className={`${flatFieldClass} font-mono`}
                />
                <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !source.trim()}
                    onClick={() => void change({ action: 'addMarketplace', source: source.trim() }, tr('添加失败', 'Could not add')).then(ok => ok && setSource(''))}
                >
                    {tr('添加', 'Add')}
                </Button>
            </div>
        </SettingRow>
    )
})

export const CodexPage = observer(() => (
    <SettingsPage title="Codex">
        <McpSection />
        <PluginsSection />
        <FeaturesSection />
    </SettingsPage>
))
