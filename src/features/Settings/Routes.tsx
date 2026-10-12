// Settings → 路由: routing groups (ordered provider/model lists). A group is a model: it shows up
// in the model picker of every agent that speaks its API, and a thread on it reaches its models
// through the app's local gateway, which tries the members in order and moves on when one fails
// before answering. Changes to a group apply to the next request.
import type { RouteApi, RouteCatalog, RouteEvent, RouteGroup, RouteMember, RouteModel, RoutesConfig, RouteStatus, RoutedAgent, TerminalAgent } from '@shared/routes'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Comment, flatFieldClass, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn, formatTokens } from '@/lib/utils'
import { appStore } from '@/store/app'
import { AGENT_APIS, FAILURE_LABELS, groupsFor, memberKey, ROUTE_API_LABELS, ROUTED_AGENT_LABELS, ROUTED_AGENTS, TERMINAL_AGENTS } from '@shared/routes'
import { ArrowDown, ArrowUp, Check, ChevronDown, GripVertical, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const pill = 'flex h-7 shrink-0 items-center gap-1 rounded-[6px] bg-[var(--jb-fill)] px-2.5 text-[12px] text-gray-800 outline-none transition-colors hover:bg-[var(--jb-fill-hover)] focus-visible:ring-2 focus-visible:ring-ide-accent/50 data-[state=open]:bg-[var(--jb-fill-hover)] disabled:opacity-50'
const iconButton = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-gray-500 outline-none hover:bg-[var(--jb-fill-hover)] hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-ide-accent/50 disabled:opacity-30 disabled:hover:bg-transparent'

const newId = () => Math.random().toString(36).slice(2, 8)

async function save(config: RoutesConfig) {
    try {
        await appStore.saveRoutes(config)
    }
    catch (error: any) {
        toast.error(tr('保存路由失败', 'Could not save routing'), { description: String(error?.message ?? error) })
    }
}

/** A copy of the config with `change` applied to one group. */
const withGroup = (config: RoutesConfig, id: string, change: (g: RouteGroup) => RouteGroup): RoutesConfig =>
    ({ ...config, groups: config.groups.map(g => (g.id === id ? change(g) : g)) })

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const RoutesPage = observer(() => {
    const state = appStore.routes
    const [catalog, setCatalog] = useState<RouteCatalog | null>(null)
    const [loading, setLoading] = useState(false)
    const revision = appStore.providersRevision
    const load = (force: boolean) => {
        setLoading(true)
        window.pi.routeCatalog(force).then(setCatalog, (error: Error) => setCatalog({ models: [], skipped: [], error: error.message })).finally(() => setLoading(false))
    }
    useEffect(() => load(revision > 0), [revision])
    if (!state)
        return <SettingsPage title={tr('路由', 'Routing')}><Comment className="py-3">{tr('加载中…', 'Loading…')}</Comment></SettingsPage>
    const { config, status } = state
    return (
        <SettingsPage
            title={tr('路由', 'Routing')}
            aside={status.port ? tr(`网关 127.0.0.1:${status.port}`, `Gateway 127.0.0.1:${status.port}`) : tr('网关未启动', 'Gateway not running')}
        >
            <div className="py-3">
                <Comment>
                    {tr(
                        '把几个供应商的模型排成一组，组就是一个模型：会出现在能用它的 agent 的模型列表里，选它的线程按顺序使用组里的模型，前一个连不上、限流、额度用完或出错时，在 agent 收到任何内容之前自动换下一个。key 来自「供应商」，只留在应用里。',
                        'Put models from several providers in a group, and the group is a model: it shows up in the model list of every agent that can use it, and a thread on it uses the group\'s models in order. When one is unreachable, rate limited, out of quota or failing, the next one takes over before the agent sees anything. Keys come from Providers and stay in the app.',
                    )}
                </Comment>
            </div>
            <div className="flex items-center gap-2 pb-1 pt-5">
                <span className="text-[12px] font-medium text-[var(--jb-comment)]">{tr('路由组', 'Groups')}</span>
                <span className="flex-1" />
                <button type="button" className={iconButton} aria-label={tr('重新读取模型', 'Reload models')} title={tr('重新读取供应商的模型', 'Read the providers\' models again')} onClick={() => load(true)}>
                    {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                </button>
                <NewGroup config={config} />
            </div>
            {catalog?.error && <Comment className="py-2 text-amber-600 dark:text-amber-400">{catalog.error}</Comment>}
            {!config.groups.length && (
                <Comment className="py-3">{tr('还没有路由组。新建一个，选好接口，再按顺序添加模型。', 'No groups yet. Create one, pick its API, then add models in order.')}</Comment>
            )}
            {config.groups.map(group => <GroupCard key={group.id} group={group} config={config} status={status} catalog={catalog} />)}
            {!!catalog?.skipped.length && (
                <Comment className="py-3">
                    {tr('不能用于路由：', 'Not usable for routing: ')}
                    {catalog.skipped.map(s => (s.reason === 'subscription' ? tr(`${s.name}（订阅登录）`, `${s.name} (subscription sign-in)`) : tr(`${s.name}（接口不支持）`, `${s.name} (unsupported API)`))).join(tr('、', ', '))}
                </Comment>
            )}
            <TerminalRow config={config} status={status} />
            <RecentEvents events={status.recent} config={config} />
            <div className="py-3">
                <Comment>
                    {tr(
                        '网关只监听本机 127.0.0.1，每个 agent 进程用自己的随机密钥访问；没有密钥的请求会被拒绝。换供应商后提示词缓存会失效，所以一次回复用上的供应商会被优先沿用几分钟。',
                        'The gateway listens on 127.0.0.1 only, and each agent process reaches it with a random key of its own; requests without one are refused. Switching providers loses the prompt cache, so the provider that answered keeps being tried first for a few minutes.',
                    )}
                </Comment>
            </div>
        </SettingsPage>
    )
})

/**
 * Terminal sync: Claude Code and Codex started from a terminal use the group picked here, pi lists
 * every group as a model, while the app runs.
 */
const TerminalRow = observer(({ config, status }: { config: RoutesConfig, status: RouteStatus }) => {
    const errors = Object.entries(status.syncErrors).filter(([agent]) => agent !== 'grok')
    const pick = (agent: TerminalAgent, id: string | undefined) => {
        const terminal = { ...config.terminal, [agent]: id }
        if (!id)
            delete terminal[agent]
        void save({ ...config, terminal })
    }
    return (
        <>
            <div className="pb-1 pt-5 text-[12px] font-medium text-[var(--jb-comment)]">{tr('终端', 'Terminal')}</div>
            <SettingRow
                title={tr('终端里也用', 'Terminals too')}
                description={tr(
                    '从终端启动的 Claude Code、Codex 用下面选的组，pi 的模型列表里出现所有组：应用会改它们的配置文件（~/.claude/settings.json、~/.codex/config.toml、~/.pi/agent/models.json），关掉或退出应用时改回原样。',
                    'Claude Code and Codex started from a terminal use the groups picked below, and pi lists every group as a model: the app edits their config files (~/.claude/settings.json, ~/.codex/config.toml, ~/.pi/agent/models.json) and puts them back when this is off or the app quits.',
                )}
                control={({ labelId, descId }) => <Switch labelledBy={labelId} describedBy={descId} checked={config.syncTerminal} onChange={on => void save({ ...config, syncTerminal: on })} />}
            >
                {errors.map(([agent, error]) => (
                    <Comment key={agent} className="mt-1.5 text-amber-600 [overflow-wrap:anywhere] dark:text-amber-400">
                        {`${ROUTED_AGENT_LABELS[agent as RoutedAgent]}: ${error}`}
                    </Comment>
                ))}
            </SettingRow>
            {config.syncTerminal && TERMINAL_AGENTS.map(agent => (
                <SettingRow
                    key={agent}
                    title={tr(`终端里的 ${ROUTED_AGENT_LABELS[agent]}`, `${ROUTED_AGENT_LABELS[agent]} in a terminal`)}
                    control={({ labelId }) => (
                        <GroupSelect
                            labelledBy={labelId}
                            groups={groupsFor(config, agent)}
                            value={config.terminal[agent]}
                            onChange={id => pick(agent, id)}
                            offLabel={tr('不改', 'Unchanged')}
                        />
                    )}
                />
            ))}
            {status.syncErrors.grok && (
                <Comment className="py-2 text-amber-600 [overflow-wrap:anywhere] dark:text-amber-400">{`Grok: ${status.syncErrors.grok}`}</Comment>
            )}
        </>
    )
})

function GroupSelect({ groups, value, onChange, offLabel, labelledBy }: { groups: RouteGroup[], value?: string, onChange: (id: string | undefined) => void, offLabel: string, labelledBy?: string }) {
    const current = groups.find(g => g.id === value)
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={pill} aria-labelledby={labelledBy} disabled={!groups.length && !value} title={!groups.length ? tr('先在下面新建一个这种接口的组', 'Create a group with this API below first') : undefined}>
                <span className="max-w-[160px] truncate">{current?.name ?? offLabel}</span>
                <ChevronDown size={12} className="text-gray-500" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[360px] w-64">
                <DropdownMenuItem onSelect={() => onChange(undefined)}>
                    <span className="flex-1">{offLabel}</span>
                    {!current && <Check size={14} className="text-ide-accent" />}
                </DropdownMenuItem>
                {!!groups.length && <DropdownMenuSeparator />}
                {groups.map(g => (
                    <DropdownMenuItem key={g.id} onSelect={() => onChange(g.id)}>
                        <span className="flex-1 truncate">{g.name}</span>
                        <span className="text-[11px] text-gray-400">{ROUTE_API_LABELS[g.api]}</span>
                        {current?.id === g.id && <Check size={14} className="text-ide-accent" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

function NewGroup({ config }: { config: RoutesConfig }) {
    const create = (api: RouteApi) => {
        const n = config.groups.length + 1
        void save({ ...config, groups: [...config.groups, { id: newId(), name: tr(`组 ${n}`, `Group ${n}`), api, mode: 'order', members: [] }] })
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={pill}>
                <Plus size={13} />
                {tr('新建组', 'New group')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>{tr('接口', 'API')}</DropdownMenuLabel>
                {(Object.keys(ROUTE_API_LABELS) as RouteApi[]).map(api => (
                    // Two lines: the API, then who can use it (pi uses any), so long names never collide.
                    <DropdownMenuItem key={api} onSelect={() => create(api)} className="h-auto flex-col items-start gap-0 py-1.5">
                        <span className="truncate">{ROUTE_API_LABELS[api]}</span>
                        <span className="truncate text-[11px] leading-4 text-gray-400">
                            {[...ROUTED_AGENTS.filter(a => a !== 'pi' && AGENT_APIS[a].includes(api)).map(a => ROUTED_AGENT_LABELS[a]), 'pi'].join(' · ')}
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

/** The member a request starts with now: the pick of a fixed group, else the first one on and not resting. */
function currentMember(group: RouteGroup, status: RouteStatus): string | undefined {
    const on = group.members.filter(m => !m.off)
    if (group.mode === 'manual')
        return memberKey(on.find(m => memberKey(m) === group.pick) ?? on[0] ?? { provider: '', model: '' }) || undefined
    const resting = (m: RouteMember) => !!(status.members[memberKey(m)]?.restUntil || status.providers[m.provider])
    const first = on.find(m => !resting(m)) ?? on[0]
    return first && memberKey(first)
}

const GroupCard = observer(({ group, config, status, catalog }: { group: RouteGroup, config: RoutesConfig, status: RouteStatus, catalog: RouteCatalog | null }) => {
    const [name, setName] = useState(group.name)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [dragging, setDragging] = useState<number | null>(null)
    useEffect(() => setName(group.name), [group.name])
    const update = (change: (g: RouteGroup) => RouteGroup) => void save(withGroup(config, group.id, change))
    const move = (from: number, to: number) => {
        if (to < 0 || to >= group.members.length || from === to)
            return
        update((g) => {
            const members = [...g.members]
            const [m] = members.splice(from, 1)
            members.splice(to, 0, m)
            return { ...g, members }
        })
    }
    // Who lists it as a model (pi uses any API).
    const users = ROUTED_AGENTS.filter(a => AGENT_APIS[a].includes(group.api))
    const current = currentMember(group, status)
    const commitName = () => {
        const trimmed = name.trim()
        if (trimmed && trimmed !== group.name)
            update(g => ({ ...g, name: trimmed }))
        else
            setName(group.name)
    }
    const remove = () => {
        const terminal = Object.fromEntries(Object.entries(config.terminal).filter(([, id]) => id !== group.id))
        void save({ ...config, groups: config.groups.filter(g => g.id !== group.id), terminal })
    }
    const models = (catalog?.models ?? []).filter(m => m.api === group.api && !group.members.some(x => x.provider === m.provider && x.model === m.id))
    const byProvider = new Map<string, RouteModel[]>()
    for (const m of models)
        byProvider.set(m.providerName, [...(byProvider.get(m.providerName) ?? []), m])
    return (
        <section aria-label={group.name} className="my-1.5 rounded-[8px] bg-[var(--jb-fill)] px-3 py-2.5">
            <div className="flex items-center gap-2">
                <input
                    aria-label={tr('组名', 'Group name')}
                    value={name}
                    maxLength={100}
                    onChange={e => setName(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter')
                            e.currentTarget.blur()
                        if (e.key === 'Escape') {
                            setName(group.name)
                            e.stopPropagation()
                        }
                    }}
                    className={cn(flatFieldClass, 'h-7 w-40 bg-transparent px-1.5 font-medium hover:bg-[var(--jb-fill)] focus:bg-[var(--jb-fill)]')}
                />
                <span className="shrink-0 whitespace-nowrap text-[11.5px] text-[var(--jb-comment)]">{ROUTE_API_LABELS[group.api]}</span>
                <span className="flex-1" />
                <Segmented
                    value={group.mode}
                    options={[{ value: 'order', label: tr('按顺序切换', 'In order') }, { value: 'manual', label: tr('固定一个', 'Fixed') }]}
                    onChange={mode => update(g => ({ ...g, mode, pick: mode === 'manual' ? g.pick ?? current : g.pick }))}
                />
                {confirmDelete
                    ? (
                            <span className="flex items-center gap-1">
                                <button type="button" className="h-6 rounded-[4px] px-2 text-[12px] text-red-600 outline-none hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-ide-accent/50 dark:text-red-400" onClick={remove}>{tr('删除', 'Delete')}</button>
                                <button type="button" className={iconButton} aria-label={tr('取消', 'Cancel')} onClick={() => setConfirmDelete(false)}><X size={13} /></button>
                            </span>
                        )
                    : (
                            <button type="button" className={iconButton} aria-label={tr('删除组', 'Delete group')} title={tr('删除组', 'Delete group')} onClick={() => setConfirmDelete(true)}>
                                <Trash2 size={13} />
                            </button>
                        )}
            </div>
            <Comment className="mt-0.5 px-1.5 text-[11.5px]">
                {tr(`在 ${users.map(a => ROUTED_AGENT_LABELS[a]).join('、')} 的模型列表里可以选它`, `Pick it in the model list of ${users.map(a => ROUTED_AGENT_LABELS[a]).join(', ')}`)}
            </Comment>
            <ol className="m-0 mt-1.5 flex list-none flex-col p-0" aria-label={tr('成员（按顺序）', 'Members (in order)')}>
                {group.members.map((m, i) => (
                    <MemberRow
                        key={memberKey(m)}
                        group={group}
                        member={m}
                        index={i}
                        current={memberKey(m) === current}
                        status={status}
                        model={catalog?.models.find(c => c.provider === m.provider && c.id === m.model)}
                        dragging={dragging === i}
                        onDragStart={() => setDragging(i)}
                        onDragEnd={() => setDragging(null)}
                        onDrop={() => {
                            if (dragging !== null)
                                move(dragging, i)
                            setDragging(null)
                        }}
                        onMove={to => move(i, to)}
                        onPick={() => update(g => ({ ...g, mode: 'manual', pick: memberKey(m) }))}
                        onToggle={on => update(g => ({ ...g, members: g.members.map((x, j) => (j === i ? (on ? { provider: x.provider, model: x.model } : { ...x, off: true }) : x)) }))}
                        onRemove={() => update(g => ({ ...g, members: g.members.filter((_, j) => j !== i) }))}
                    />
                ))}
            </ol>
            {!group.members.length && <Comment className="py-1.5 pl-1">{tr('还没有模型。', 'No models yet.')}</Comment>}
            <div className="mt-1">
                <DropdownMenu>
                    <DropdownMenuTrigger className="flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-[12px] text-gray-600 outline-none hover:bg-[var(--jb-fill-hover)] hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-ide-accent/50 data-[state=open]:bg-[var(--jb-fill-hover)]" disabled={!catalog}>
                        <Plus size={13} />
                        {tr('添加模型', 'Add model')}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-[360px] w-80">
                        {!models.length && (
                            <div className="px-2 py-1.5 text-[12px] text-[var(--jb-comment)]">
                                {tr(`「供应商」里没有更多 ${ROUTE_API_LABELS[group.api]} 接口、已填 key 的模型。`, `No more ${ROUTE_API_LABELS[group.api]} models with a key in Providers.`)}
                            </div>
                        )}
                        {[...byProvider.entries()].map(([provider, list]) => (
                            <div key={provider}>
                                <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                                {list.map(m => (
                                    <DropdownMenuItem key={`${m.provider}/${m.id}`} onSelect={() => update(g => ({ ...g, members: [...g.members, { provider: m.provider, model: m.id }] }))}>
                                        <span className="flex-1 truncate">{m.name}</span>
                                        {m.contextWindow ? <span className="text-[11px] text-gray-400">{formatTokens(m.contextWindow)}</span> : null}
                                    </DropdownMenuItem>
                                ))}
                            </div>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </section>
    )
})

const MemberRow = observer(({ group, member, index, current, status, model, dragging, onDragStart, onDragEnd, onDrop, onMove, onPick, onToggle, onRemove }: {
    group: RouteGroup
    member: RouteMember
    index: number
    current: boolean
    status: RouteStatus
    model?: RouteModel
    dragging: boolean
    onDragStart: () => void
    onDragEnd: () => void
    onDrop: () => void
    onMove: (to: number) => void
    onPick: () => void
    onToggle: (on: boolean) => void
    onRemove: () => void
}) => {
    const [over, setOver] = useState(false)
    const key = memberKey(member)
    const health = status.members[key]
    const providerRest = status.providers[member.provider]
    const restUntil = Math.max(health?.restUntil ?? 0, providerRest?.restUntil ?? 0)
    const reason = (health?.restUntil ?? 0) >= (providerRest?.restUntil ?? 0) ? health?.reason : providerRest?.reason
    const recentError = health?.lastError && (!health.lastOk || health.lastError.at > health.lastOk) ? health.lastError : undefined
    let note: { text: string, tone: 'warn' | 'muted' } | undefined
    if (member.off)
        note = { text: tr('已暂停', 'Paused'), tone: 'muted' }
    else if (restUntil)
        note = { text: tr(`${FAILURE_LABELS[reason ?? 'server'].zh}，${time(restUntil)} 前排到最后`, `${FAILURE_LABELS[reason ?? 'server'].en}, tried last until ${time(restUntil)}`), tone: 'warn' }
    else if (recentError)
        note = { text: tr(`${time(recentError.at)} 失败：${FAILURE_LABELS[recentError.kind].zh}`, `Failed at ${time(recentError.at)}: ${FAILURE_LABELS[recentError.kind].en}`), tone: 'warn' }
    const errorTitle = recentError ? `${recentError.status ? `HTTP ${recentError.status} · ` : ''}${recentError.message}` : undefined
    return (
        <li
            draggable
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                onDragStart()
            }}
            onDragEnd={onDragEnd}
            onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
                e.preventDefault()
                setOver(false)
                onDrop()
            }}
            className={cn('group/member flex h-9 items-center gap-2 rounded-[6px] px-1', dragging && 'opacity-40', over && 'bg-[var(--jb-fill-hover)]')}
        >
            <GripVertical aria-hidden size={13} className="shrink-0 cursor-grab text-gray-400" />
            <button
                type="button"
                role="radio"
                aria-checked={current}
                aria-label={tr(`使用 ${model?.name ?? member.model}`, `Use ${model?.name ?? member.model}`)}
                title={group.mode === 'manual' ? tr('固定使用这个', 'Use only this one') : tr('点一下改为固定使用这个', 'Click to use only this one')}
                disabled={member.off}
                onClick={onPick}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50 disabled:opacity-40"
            >
                <span className={cn('flex h-3.5 w-3.5 items-center justify-center rounded-full', current ? 'bg-ide-accent' : 'bg-[var(--jb-fill-hover)]')}>
                    {current && <span className="h-1.5 w-1.5 rounded-full bg-always-white" />}
                </span>
            </button>
            <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-gray-400">{index + 1}</span>
            <div className={cn('min-w-0 flex-1', member.off && 'opacity-50')}>
                <div className="flex items-baseline gap-1.5 text-[12.5px] leading-4">
                    <span className="truncate text-gray-900">{model?.name ?? member.model}</span>
                    <span className="shrink-0 truncate text-[11.5px] text-[var(--jb-comment)]">{model?.providerName ?? member.provider}</span>
                    {current && <span className="shrink-0 text-[11px] text-ide-accent">{tr('使用中', 'In use')}</span>}
                    {!model && <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">{tr('模型或 key 不在了', 'Model or key gone')}</span>}
                </div>
                {note && <div title={errorTitle} className={cn('truncate text-[11px] leading-4', note.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--jb-comment)]')}>{note.text}</div>}
            </div>
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/member:opacity-100 group-hover/member:opacity-100">
                <button type="button" className={iconButton} aria-label={tr('上移', 'Move up')} disabled={index === 0} onClick={() => onMove(index - 1)}><ArrowUp size={13} /></button>
                <button type="button" className={iconButton} aria-label={tr('下移', 'Move down')} disabled={index === group.members.length - 1} onClick={() => onMove(index + 1)}><ArrowDown size={13} /></button>
                <button type="button" className={iconButton} aria-label={tr('移除', 'Remove')} onClick={onRemove}><X size={13} /></button>
            </span>
            <Switch checked={!member.off} onChange={onToggle} />
        </li>
    )
})

const RecentEvents = observer(({ events, config }: { events: RouteEvent[], config: RoutesConfig }) => {
    if (!events.length)
        return null
    const groupName = (id: string) => config.groups.find(g => g.id === id)?.name ?? id
    return (
        <div className="py-3">
            <div className="pb-1.5 text-[12px] font-medium text-[var(--jb-comment)]">{tr('最近的切换', 'Recent switches')}</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {events.slice(0, 8).map(e => (
                    <li key={`${e.at}-${e.agent}`} className="flex gap-2 text-[11.5px] leading-4 text-gray-700">
                        <span className="shrink-0 tabular-nums text-[var(--jb-comment)]">{time(e.at)}</span>
                        <span className="shrink-0 text-[var(--jb-comment)]">{`${ROUTED_AGENT_LABELS[e.agent]} · ${groupName(e.group)}`}</span>
                        <span className="min-w-0 truncate" title={e.failed.map(f => `${f.member}: ${f.message}`).join('\n')}>
                            {e.failed.map(f => tr(`${f.member}（${FAILURE_LABELS[f.kind].zh}）`, `${f.member} (${FAILURE_LABELS[f.kind].en})`)).join(' → ')}
                            {e.served ? ` → ${e.served}` : tr(' → 全部失败', ' → all failed')}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    )
})
