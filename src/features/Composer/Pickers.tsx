import type { AgentAvailability, AgentKind } from '@shared/agents'
import type { PiModel, ThinkingLevel } from '@shared/pi'
import type { PiDefaults } from '@shared/ipc'
import { modelKey } from '@shared/pi'
import type { KeyboardEvent } from 'react'
import type { Thread, ThreadMode } from '@/store/thread'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatTokens, ipcMessage } from '@/lib/utils'
import { AgentIcon } from '@/components/AgentIcon'
import { Brain, Check, ChevronDown, ClipboardList, Cpu, Download, FilePen, KeyRound, Loader2, Plane, Plus, Route, Settings2, ShieldCheck, SlidersHorizontal, Undo2, Zap } from 'lucide-react'
import { observable, runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { tr } from '@/lib/i18n'
import { agentsStore } from '@/store/agents'
import { appStore } from '@/store/app'
import type { Localized } from '@shared/i18n'
import type { RouteModel, TerminalAgent } from '@shared/routes'
import { AGENT_APIS, memberKey, ROUTED_AGENT_LABELS, ROUTES_PROVIDER, TERMINAL_AGENTS } from '@shared/routes'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { flatFieldClass } from '@/components/ui/form'

const pill = 'flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-gray-600 outline-none transition-colors hover:bg-black/[0.06] hover:text-gray-900 data-[state=open]:bg-black/[0.08] disabled:opacity-50'

const LEVEL_LABEL: Record<ThinkingLevel, Localized> = {
    off: { zh: '关闭', en: 'Off' },
    minimal: { zh: '最低', en: 'Minimal' },
    low: { zh: '低', en: 'Low' },
    medium: { zh: '中', en: 'Medium' },
    high: { zh: '高', en: 'High' },
    xhigh: { zh: '超高', en: 'X-High' },
    max: { zh: '最高', en: 'Max' },
}

/** ACP agents add their own levels (Claude Code: "default"). */
const EXTRA_LEVEL_LABEL: Record<string, Localized> = { default: { zh: '默认', en: 'Default' } }

const levelLabel = (level: ThinkingLevel): string => {
    const label = LEVEL_LABEL[level] ?? EXTRA_LEVEL_LABEL[level]
    return label ? tr(label) : level
}

/** pi started but has no provider to take a model from: nothing in the thread can run yet. */
const lacksModels = (thread: Thread) => thread.agent === 'pi' && thread.agentStatus === 'ready' && !thread.models.length

/** Above the composer while no model is usable, with the way to fix it. */
export const NoModelNotice = observer(({ thread }: { thread: Thread }) => {
    if (!lacksModels(thread))
        return null
    return (
        <div role="status" className="mb-2 flex items-center gap-3 rounded-md bg-ide-block px-3 py-2 text-[12.5px] text-gray-700">
            <KeyRound size={14} className="shrink-0 text-gray-500" />
            <span className="min-w-0 flex-1">
                {tr('pi 还没有可用的模型。登录一个供应商、填写 API key，或者接入本地模型。', 'pi has no model to use yet. Sign in to a provider, enter an API key, or connect a local model.')}
            </span>
            <button
                type="button"
                onClick={() => appStore.openProviders()}
                className="shrink-0 rounded-md bg-ide-accent px-2.5 py-1 text-[12px] text-always-white outline-none hover:bg-ide-accent-hover focus-visible:ring-2 focus-visible:ring-ide-accent/50"
            >
                {tr('配置供应商', 'Set up a provider')}
            </button>
        </div>
    )
})

/** Groups go by as models of this provider id (pi) or with this id prefix (Grok's config.toml). */
const isGroupModel = (model: PiModel) => model.provider === ROUTES_PROVIDER || model.id.startsWith(`${ROUTES_PROVIDER}-`)
const countModels = (n: number) => tr(`${n} 个模型`, n === 1 ? '1 model' : `${n} models`)
const memberModel = (key: string) => key.slice(key.indexOf('/') + 1)

/**
 * The agent's own models, the provider models it can use (Claude Code, Codex: groups of one, by
 * provider), then the routing groups: every agent picks a group the way it picks a model. On a group,
 * its members follow, to pin one for this thread.
 */
export const ModelPicker = observer(({ thread }: { thread: Thread }) => {
    const [adding, setAdding] = useState(false)
    const [defaults, setDefaults] = useState<PiDefaults>()
    if (lacksModels(thread)) {
        return (
            <button type="button" className={cn(pill, 'text-ide-accent hover:text-ide-accent')} onClick={() => appStore.openProviders()}>
                <KeyRound size={13} />
                <span>{tr('无可用模型', 'No models')}</span>
            </button>
        )
    }
    const current = thread.state?.model
    const group = thread.routeGroup
    const groups = thread.routeGroups
    const pin = thread.route.pin && group?.members.some(m => !m.off && memberKey(m) === thread.route.pin) ? thread.route.pin : undefined
    const served = pin ?? (thread.routeInfo?.group?.id === group?.id ? thread.routeInfo?.served : undefined)
    // Claude Code / Codex: pi's provider models of their API, written into their own config when picked.
    const channelAgent = TERMINAL_AGENTS.find(a => a === thread.agent)
    const channel = thread.channel
    const onChannel = !group && channel?.current
    const channels = new Map<string, RouteModel[]>()
    for (const model of channelAgent ? (appStore.routes?.models ?? []).filter(m => AGENT_APIS[channelAgent].includes(m.api)) : []) {
        const list = channels.get(model.providerName) ?? []
        list.push(model)
        channels.set(model.providerName, list)
    }
    const byProvider = new Map<string, PiModel[]>()
    // On a channel, the agent's own list is its vendor's, not what the channel serves.
    for (const model of onChannel ? [] : thread.models.filter(m => !isGroupModel(m))) {
        const list = byProvider.get(model.provider) ?? []
        list.push(model)
        byProvider.set(model.provider, list)
    }
    // Other agents than pi restart onto a group or channel (or off it): not mid-run.
    const restarts = thread.agent !== 'pi'
    const busy = restarts && thread.running
    const label = group
        ? `${group.name}${served ? ` · ${memberModel(served)}` : ''}`
        : current?.name ?? (onChannel ? channel.current!.model : thread.agentStatus === 'starting' ? tr('加载中…', 'Loading…') : tr('选择模型', 'Choose model'))
    return (
        <>
            <DropdownMenu
                onOpenChange={(open) => {
                    if (open && thread.agent === 'pi')
                        void window.pi.piDefaults(thread.cwd).then(setDefaults, () => setDefaults(undefined))
                    if (open && channelAgent) {
                        void thread.refreshChannel()
                        void window.pi.routeCatalog()
                    }
                }}
            >
                <DropdownMenuTrigger className={pill} disabled={!thread.models.length && !groups.length && !channelAgent} title={group ? tr('路由组：按顺序使用组里的模型', 'Routing group: its models in order') : undefined}>
                    {group ? <Route size={13} /> : <Cpu size={13} />}
                    <span className="max-w-[200px] truncate">{label}</span>
                    <ChevronDown size={12} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72 max-h-[460px]">
                    {[...byProvider.entries()].map(([provider, models]) => (
                        <div key={provider}>
                            <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                            {models.map(model => (
                                <DropdownMenuItem key={`${provider}/${model.id}`} disabled={busy && !!group} onSelect={() => void thread.setModel(model)}>
                                    <span className="flex-1 truncate">{model.name}</span>
                                    {thread.agent === 'pi' && modelKey(model) === defaults?.model && <span className="text-[11px] text-gray-400">{tr('默认', 'default')}</span>}
                                    {model.contextWindow ? <span className="text-[11px] text-gray-400">{formatTokens(model.contextWindow)}</span> : null}
                                    {!group && current?.provider === model.provider && current.id === model.id && <Check size={14} className="text-ide-accent" />}
                                </DropdownMenuItem>
                            ))}
                        </div>
                    ))}
                    {!!channelAgent && (
                        <>
                            {!!byProvider.size && <DropdownMenuSeparator />}
                            {channel?.other && !channel.current && (
                                <div className="truncate px-2 py-1 text-[11.5px] text-gray-500">{tr(`配置里现在是 ${channel.other}`, `Its config points at ${channel.other}`)}</div>
                            )}
                            {[...channels.entries()].map(([provider, models]) => (
                                <div key={provider}>
                                    <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                                    {models.map(m => (
                                        <DropdownMenuItem key={`${m.provider}/${m.id}`} disabled={busy} onSelect={() => void thread.useChannel({ provider: m.provider, model: m.id })}>
                                            <span className="flex-1 truncate">{m.name}</span>
                                            {m.contextWindow ? <span className="text-[11px] text-gray-400">{formatTokens(m.contextWindow)}</span> : null}
                                            {onChannel && channel.current!.provider === m.provider && channel.current!.model === m.id && <Check size={14} className="text-ide-accent" />}
                                        </DropdownMenuItem>
                                    ))}
                                </div>
                            ))}
                            {channel?.restore !== undefined && (
                                <DropdownMenuItem disabled={busy} onSelect={() => void thread.useChannel(null)}>
                                    <Undo2 size={13} />
                                    <span className="flex-1 truncate">{channel.restore ? tr(`换回原来的 ${channel.restore}`, `Back to ${channel.restore}`) : tr(`换回 ${ROUTED_AGENT_LABELS[channelAgent]} 自己的登录`, `Back to ${ROUTED_AGENT_LABELS[channelAgent]}'s own sign-in`)}</span>
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem disabled={busy} onSelect={() => setAdding(true)}>
                                <Plus size={13} />
                                <span className="flex-1">{tr('添加渠道…', 'Add a channel…')}</span>
                            </DropdownMenuItem>
                        </>
                    )}
                    {!!groups.length && (
                        <>
                            {!!(byProvider.size || channelAgent) && <DropdownMenuSeparator />}
                            <DropdownMenuLabel>{tr('路由组', 'Routing groups')}</DropdownMenuLabel>
                            {groups.map(g => (
                                <div key={g.id}>
                                    <DropdownMenuItem disabled={busy && group?.id !== g.id} onSelect={() => void thread.chooseGroup(g.id)}>
                                        <Route size={13} />
                                        <span className="flex-1 truncate">{g.name}</span>
                                        <span className="text-[11px] text-gray-400">{countModels(g.members.filter(m => !m.off).length)}</span>
                                        {group?.id === g.id && <Check size={14} className="text-ide-accent" />}
                                    </DropdownMenuItem>
                                    {group?.id === g.id && (
                                        <>
                                            <DropdownMenuItem inset onSelect={() => void thread.setRoute({})} className="h-6 text-[12px]">
                                                <span className="flex-1 truncate">{g.mode === 'manual' ? tr('用组里固定的那个', 'The group\'s fixed one') : tr('按顺序，失败换下一个', 'In order, next on failure')}</span>
                                                {!pin && <Check size={13} className="text-ide-accent" />}
                                            </DropdownMenuItem>
                                            {g.members.filter(m => !m.off).map((m) => {
                                                const key = memberKey(m)
                                                return (
                                                    <DropdownMenuItem key={key} inset onSelect={() => void thread.setRoute({ pin: key })} className="h-6 text-[12px]">
                                                        <span className="flex-1 truncate">{tr(`只用 ${m.model}`, `Only ${m.model}`)}</span>
                                                        <span className="max-w-[90px] truncate text-[11px] text-gray-400">{m.provider}</span>
                                                        {pin === key && <Check size={13} className="text-ide-accent" />}
                                                    </DropdownMenuItem>
                                                )
                                            })}
                                        </>
                                    )}
                                </div>
                            ))}
                        </>
                    )}
                    {busy && <div className="px-2 py-1 text-[11.5px] text-gray-500">{tr('这一轮结束后才能换模型', 'Models switch once this turn is over')}</div>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => appStore.openSettings('routes')}>
                        <Settings2 size={13} />
                        <span className="flex-1">{groups.length ? tr('管理路由组…', 'Manage routing groups…') : tr('新建路由组…', 'New routing group…')}</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {channelAgent && <AddChannel thread={thread} agent={channelAgent} open={adding} onOpenChange={setAdding} />}
        </>
    )
})

/**
 * A channel is an address and a key: the API is the agent's, the name and models come from the
 * endpoint. Saved as a pi provider (Providers), then written into the agent's own config, so
 * a terminal run uses it too.
 */
const AddChannel = observer(({ thread, agent, open, onOpenChange }: { thread: Thread, agent: TerminalAgent, open: boolean, onOpenChange: (open: boolean) => void }) => {
    const [baseUrl, setBaseUrl] = useState('')
    const [apiKey, setApiKey] = useState('')
    const [model, setModel] = useState('')
    const [needsModel, setNeedsModel] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const name = ROUTED_AGENT_LABELS[agent]
    const field = cn(flatFieldClass, 'w-full font-mono')
    const save = async () => {
        setBusy(true)
        setError('')
        try {
            const added = await window.pi.addChannel(agent, { baseUrl, apiKey, model: needsModel ? model : undefined })
            if ('listError' in added) {
                setError(`${added.listError}\n${tr('没能获取模型列表，填一个模型名再保存。', 'Could not list the models; enter a model name and save again.')}`)
                setNeedsModel(true)
                return
            }
            onOpenChange(false)
            setBaseUrl('')
            setApiKey('')
            setModel('')
            setNeedsModel(false)
            await thread.channelChosen(added)
        }
        catch (e) {
            setError(ipcMessage(e))
        }
        finally {
            setBusy(false)
        }
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[440px] gap-3 p-5">
                <DialogTitle className="text-[14px]">{tr(`添加 ${name} 渠道`, `Add a ${name} channel`)}</DialogTitle>
                <DialogDescription className="text-[12px] text-[var(--jb-comment)]">
                    {tr(`保存到「供应商」（同一个地址和 key 只存一份，其他 agent 也能用），并写进 ${name} 自己的配置：终端里的 ${agent} 也用它。`, `Saved to Providers (one entry per address and key, for every agent) and written into ${name}'s own config, so ${agent} in a terminal uses it too.`)}
                </DialogDescription>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                        e.preventDefault()
                        void save()
                    }}
                >
                    <input className={field} value={baseUrl} spellCheck={false} autoFocus placeholder={agent === 'claude' ? 'https://api.example.com' : 'https://api.example.com/v1'} aria-label={tr('地址', 'Address')} onChange={e => setBaseUrl(e.target.value)} />
                    <input className={field} type="password" autoComplete="off" value={apiKey} placeholder="sk-…" aria-label="API key" onChange={e => setApiKey(e.target.value)} />
                    {needsModel && <input className={field} value={model} spellCheck={false} placeholder={agent === 'claude' ? 'claude-sonnet-4-5' : 'gpt-5'} aria-label={tr('模型', 'Model')} onChange={e => setModel(e.target.value)} />}
                    {error && <div role="alert" className="whitespace-pre-wrap text-[12px] text-red-600 dark:text-red-400">{error}</div>}
                    <div className="flex justify-end gap-2 pt-1">
                        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{tr('取消', 'Cancel')}</Button>
                        <Button type="submit" variant="primary" size="sm" disabled={busy || !baseUrl.trim() || !apiKey.trim() || (needsModel && !model.trim())}>
                            {busy && <Loader2 size={13} className="animate-spin" />}
                            {tr('保存并使用', 'Save and use')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
})

/**
 * Thinking effort as a stepped slider, like the Codex app: drag the knob or click a stop; with focus,
 * arrows / Home / End step through levels. Only the released position is sent to pi.
 */
const EffortSlider = observer(function EffortSlider({ levels, value, onChange }: { levels: ThinkingLevel[], value?: ThinkingLevel, onChange: (level: ThinkingLevel) => Promise<void> }) {
    const trackRef = useRef<HTMLDivElement>(null)
    const [drag, setDrag] = useState<number | null>(null)
    // Holds the released stop until pi confirms, so the knob does not jump back meanwhile.
    const [pending, setPending] = useState<number | null>(null)
    const last = levels.length - 1
    const index = Math.max(0, value ? levels.indexOf(value) : 0)
    const shown = drag ?? pending ?? index
    const pct = (i: number) => `${(i / last) * 100}%`

    const stopAt = (clientX: number) => {
        const rect = trackRef.current!.getBoundingClientRect()
        return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * last)
    }
    const commit = (i: number) => {
        if (levels[i] === value)
            return
        setPending(i)
        void onChange(levels[i]).finally(() => setPending(null))
    }
    const onKeyDown = (e: KeyboardEvent) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]
        const next = step !== undefined ? shown + step : e.key === 'Home' ? 0 : e.key === 'End' ? last : null
        if (next === null)
            return
        e.preventDefault()
        commit(Math.min(last, Math.max(0, next)))
    }

    return (
        <div className="select-none">
            <div className="text-[12px] text-gray-500">{tr('思考强度', 'Thinking effort')}</div>
            <div
                role="slider"
                tabIndex={0}
                aria-label={tr('思考强度', 'Thinking effort')}
                aria-valuemin={0}
                aria-valuemax={last}
                aria-valuenow={shown}
                aria-valuetext={levelLabel(levels[shown])}
                className="group relative mt-2 h-6 cursor-pointer touch-none outline-none"
                onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    setDrag(stopAt(e.clientX))
                }}
                onPointerMove={e => drag !== null && setDrag(stopAt(e.clientX))}
                onPointerUp={(e) => {
                    if (drag === null)
                        return
                    commit(stopAt(e.clientX))
                    setDrag(null)
                }}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={onKeyDown}
            >
                <div ref={trackRef} className="absolute inset-x-[7px] top-1/2 h-1 -translate-y-1/2 rounded-full bg-black/[0.08]">
                    {levels.map((level, i) => (
                        <span key={level} className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/[0.2]" style={{ left: pct(i) }} />
                    ))}
                    <div className="absolute inset-y-0 left-0 rounded-full bg-ide-accent transition-[width] duration-100" style={{ width: pct(shown) }} />
                    <span
                        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-always-white shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.3)] transition-[left] duration-100 group-focus-visible:ring-2 group-focus-visible:ring-ide-accent/50"
                        style={{ left: pct(shown) }}
                    />
                </div>
            </div>
            <div aria-hidden className="relative mx-[7px] h-4 text-[11px]">
                {levels.map((level, i) => (
                    <span
                        key={level}
                        className={cn('absolute -translate-x-1/2 cursor-pointer whitespace-nowrap transition-colors', i === shown ? 'text-gray-900' : 'text-gray-400 hover:text-gray-700')}
                        style={{ left: pct(i) }}
                        onClick={() => commit(i)}
                    >
                        {levelLabel(level)}
                    </span>
                ))}
            </div>
        </div>
    )
})

export const ThinkingPicker = observer(({ thread }: { thread: Thread }) => {
    const levels = thread.thinkingLevels
    const current = thread.state?.thinkingLevel
    if (levels.length <= 1)
        return null
    return (
        <Popover>
            <PopoverTrigger className={pill}>
                <Brain size={13} />
                <span>{current ? levelLabel(current) : tr('思考', 'Thinking')}</span>
                <ChevronDown size={12} />
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-[300px] px-4 pt-3 pb-2.5">
                <EffortSlider levels={levels} value={current} onChange={level => thread.setThinkingLevel(level)} />
            </PopoverContent>
        </Popover>
    )
})

const MODES: { mode: ThreadMode, label: Localized, hint: Localized, icon: typeof Zap }[] = [
    { mode: 'ask', label: { zh: '每次确认', en: 'Ask every time' }, hint: { zh: '改文件、跑命令前都先问你', en: 'Asks before any file edit or command' }, icon: ShieldCheck },
    { mode: 'edits', label: { zh: '自动编辑', en: 'Auto-edit' }, hint: { zh: '项目里的文件改动直接做，命令仍先问你', en: 'Edits project files freely; still asks before commands' }, icon: FilePen },
    { mode: 'auto', label: { zh: '全自动', en: 'Full auto' }, hint: { zh: '不再询问', en: 'Never asks' }, icon: Zap },
    { mode: 'plan', label: { zh: '计划', en: 'Plan' }, hint: { zh: '只读探索，写出计划等你批准后再动手', en: 'Explores read-only and waits for you to approve a plan' }, icon: ClipboardList },
]

/**
 * Approval mode and plan mode in one menu: plan is a stage before any approval matters, so they
 * read as one "how much may pi do" choice. Entries appear for the capabilities this thread loaded.
 */
export const ModePicker = observer(({ thread }: { thread: Thread }) => {
    const current = thread.mode
    const hasApproval = thread.approvalMode !== undefined
    const hasPlan = thread.guiCommands.includes('gui-plan')
    // Without approval, 全自动 is how plan mode is left.
    const options = MODES.filter(m => m.mode === 'plan' ? hasPlan : hasApproval || (m.mode === 'auto' && hasPlan))
    if (!options.length)
        return null
    // Plan loaded without approval: outside plan mode pi runs everything, like 全自动.
    const active = MODES.find(m => m.mode === (current ?? 'auto'))!
    const Icon = active.icon
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={cn(pill, current === 'plan' && 'text-ide-accent hover:text-ide-accent')} title={tr(active.hint)}>
                <Icon size={13} />
                <span>{tr(active.label)}</span>
                <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
                {options.map(({ mode, label, hint, icon: ItemIcon }) => (
                    <DropdownMenuItem key={mode} onSelect={() => void thread.setMode(mode)} className="h-auto items-start py-1.5">
                        <ItemIcon size={14} className="mt-0.5 shrink-0 text-gray-500" />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span>{tr(label)}</span>
                            <span className="text-[11.5px] text-gray-500">{tr(hint)}</span>
                        </span>
                        {mode === current && <Check size={14} className="mt-0.5 text-ide-accent" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

/** Options with their own picker (ModelPicker, ThinkingPicker); the rest get ConfigPickers. */
const PLACED_CATEGORIES = new Set(['model', 'thought_level'])

/** An ACP agent's own session settings (Codex: mode, collaboration mode, fast mode, …), one menu each. */
export const ConfigPickers = observer(({ thread }: { thread: Thread }) => {
    if (!thread.features.configOptions)
        return null
    const options = thread.configOptions.filter(o => !PLACED_CATEGORIES.has(o.category ?? '') && o.options.length > 1)
    return (
        <>
            {options.map((option) => {
                const current = option.options.find(o => o.value === option.currentValue)
                const Icon = option.category === 'mode' ? ShieldCheck : SlidersHorizontal
                return (
                    <DropdownMenu key={option.id}>
                        <DropdownMenuTrigger className={pill} title={option.description ?? option.name} aria-label={`${option.name}: ${current?.name ?? option.currentValue}`}>
                            <Icon size={13} />
                            <span className="max-w-[140px] truncate">{current?.name ?? option.currentValue}</span>
                            <ChevronDown size={12} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-80">
                            <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
                            {option.options.map(choice => (
                                <DropdownMenuItem key={choice.value} onSelect={() => void thread.setConfigOption(option.id, choice.value)} className="h-auto items-start py-1.5">
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span>{choice.name}</span>
                                        {choice.description && <span className="text-[11.5px] text-gray-500">{choice.description}</span>}
                                    </span>
                                    {choice.value === option.currentValue && <Check size={14} className="mt-0.5 text-ide-accent" />}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )
            })}
        </>
    )
})

function agentHint(agent: AgentAvailability): string | undefined {
    if (agent.installing)
        return tr('安装中…', 'Installing…')
    if (!agent.available && agent.installable && agent.cli)
        return tr('已装 CLI，缺 ACP 适配器，选中后自动安装', 'CLI found; pick it to add the ACP adapter')
    if (!agent.available)
        return agent.installable ? tr('未安装，选中后自动安装', 'Not installed; pick it to install') : agent.error
    if (agent.via === 'app')
        return agent.outdated ? tr('有新版本，可在 设置 → Agent 里更新', 'An update is available in Settings → Agents') : tr('已由应用安装', 'Installed by the app')
    return agent.command
}

/** The agent a thread is waiting on an install for, by thread key. */
const installingFor = observable.map<string, AgentKind>()

/**
 * The agent this thread waits on an install for. Sending meanwhile would go to pi and pin the
 * thread to it, so the composer holds the message until the install ends.
 */
export function installingAgentLabel(thread: Thread): string | undefined {
    const pending = installingFor.get(thread.key)
    return pending && (agentsStore.get(pending)?.label ?? pending)
}

async function pickAgent(thread: Thread, agent: AgentAvailability | undefined, id: AgentKind) {
    if (id === 'pi' || agent?.available) {
        await thread.setAgent(id)
        return
    }
    if (!agent?.installable && !agent?.installing)
        return
    runInAction(() => installingFor.set(thread.key, id))
    const ok = await agentsStore.install(id)
    runInAction(() => installingFor.delete(thread.key))
    // Still a fresh thread, and nobody picked another agent meanwhile.
    if (ok && thread.agentSwitchable)
        await thread.setAgent(id)
}

/** Which agent a fresh thread runs: pi, or an ACP agent (Codex, …). Gone once the thread has history. */
export const AgentPicker = observer(({ thread }: { thread: Thread }) => {
    useEffect(() => agentsStore.ensure(), [])
    const agents = agentsStore.list
    if (!thread.agentSwitchable && thread.agent === 'pi')
        return null
    if (!thread.agentSwitchable || !agents.length) {
        // A thread of another agent keeps saying which one it is.
        return thread.agent === 'pi'
            ? null
            : <span className={cn(pill, 'pointer-events-none')}><AgentIcon agent={thread.agent} /><span>{thread.agentLabel}</span></span>
    }
    const pending = installingFor.get(thread.key)
    const pendingLabel = pending && agentsStore.get(pending)?.label
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={pill} title={tr('这个线程用哪个 Agent', 'Which agent runs this thread')} aria-label={tr(`Agent：${thread.agentLabel}`, `Agent: ${thread.agentLabel}`)}>
                {pendingLabel ? <Loader2 size={13} className="animate-spin" /> : <AgentIcon agent={thread.agent} />}
                <span>{pendingLabel ? tr(`正在安装 ${pendingLabel}…`, `Installing ${pendingLabel}…`) : thread.agentLabel}</span>
                <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
                <DropdownMenuLabel>{tr('Agent', 'Agent')}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void pickAgent(thread, undefined, 'pi')} className="h-auto items-start py-1.5">
                    <AgentIcon agent="pi" className="mt-0.5" />
                    <span className="min-w-0 flex-1">pi</span>
                    {thread.agent === 'pi' && <Check size={14} className="mt-0.5 text-ide-accent" />}
                </DropdownMenuItem>
                {agents.map((agent) => {
                    const install = !agent.available && (agent.installable || agent.installing)
                    return (
                        <DropdownMenuItem
                            key={agent.id}
                            disabled={!agent.available && !install}
                            onSelect={() => void pickAgent(thread, agent, agent.id)}
                            className="h-auto items-start py-1.5"
                        >
                            <AgentIcon agent={agent.id} className="mt-0.5" />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span>{agent.label}</span>
                                {agentHint(agent) && <span className="text-[11.5px] break-all text-gray-500">{agentHint(agent)}</span>}
                            </span>
                            {agent.id === thread.agent && <Check size={14} className="mt-0.5 text-ide-accent" />}
                            {install && (
                                <span className="mt-px flex shrink-0 items-center gap-1 rounded-[4px] bg-ide-accent/[0.14] px-1.5 py-px text-[11.5px] text-ide-accent dark:text-[#8fb3ff]">
                                    {agent.installing ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                                    {agent.installing ? tr('安装中', 'Installing') : tr('安装', 'Install')}
                                </span>
                            )}
                        </DropdownMenuItem>
                    )
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

/**
 * Autopilot on/off for this thread (a supervisor answers the agent in the user's place), with what
 * it is doing: a pulsing dot while it judges a run, the cards waiting for the user.
 */
export const AutopilotToggle = observer(({ thread }: { thread: Thread }) => {
    if (!thread.autopilotAvailable)
        return null
    const status = thread.autopilot
    const on = !!status && status.phase !== 'off'
    const pending = status?.pending ?? 0
    const hint = on
        ? status!.phase === 'supervising'
            ? tr(`监督者在判断上一轮${status!.last ? `：${status!.last}` : ''}`, `The supervisor is judging the last run${status!.last ? `: ${status!.last}` : ''}`)
            : tr('已开：每轮结束后由监督者替你回复，只有要你拍板的事才停下。点击关闭', 'On: after each run a supervisor replies for you, stopping only for what you decide. Click to turn off')
        : tr('每轮结束后由一个只读的监督者替你回复，只有要你拍板的事才停下等你', 'After each run a read-only supervisor replies for you, stopping only for what you decide')
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => void thread.setAutopilot(!on)}
            title={hint}
            className={cn(pill, on && 'text-ide-accent hover:text-ide-accent')}
        >
            <Plane size={13} />
            <span>{tr('自动驾驶', 'Autopilot')}</span>
            {status?.phase === 'supervising' && <span aria-label={tr('监督中', 'Supervising')} className="size-1.5 shrink-0 animate-pulse rounded-full bg-ide-accent" />}
            {pending > 0 && <span className="tabular-nums text-amber-600 dark:text-amber-400">{tr(`${pending} 张卡片`, `${pending} card${pending === 1 ? '' : 's'}`)}</span>}
        </button>
    )
})
