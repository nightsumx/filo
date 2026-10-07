import type { AgentAvailability, AgentKind } from '@shared/agents'
import type { PiModel, ThinkingLevel } from '@shared/pi'
import type { KeyboardEvent } from 'react'
import type { Thread, ThreadMode } from '@/store/thread'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatTokens } from '@/lib/utils'
import { Bot, Brain, Check, ChevronDown, ClipboardList, Cpu, FilePen, KeyRound, ShieldCheck, SlidersHorizontal, Zap } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import type { Localized } from '@shared/i18n'

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

const levelLabel = (level: ThinkingLevel): string => (LEVEL_LABEL[level] ? tr(LEVEL_LABEL[level]) : level)

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
                {tr('pi 还没有可用的模型。登录一个模型供应商、填写 API key，或者接入本地模型。', 'pi has no model to use yet. Sign in to a model provider, enter an API key, or connect a local model.')}
            </span>
            <button
                type="button"
                onClick={() => appStore.openProviders()}
                className="shrink-0 rounded-md bg-ide-accent px-2.5 py-1 text-[12px] text-always-white outline-none hover:bg-ide-accent-hover focus-visible:ring-2 focus-visible:ring-ide-accent/50"
            >
                {tr('配置模型供应商', 'Set up a provider')}
            </button>
        </div>
    )
})

export const ModelPicker = observer(({ thread }: { thread: Thread }) => {
    if (lacksModels(thread)) {
        return (
            <button type="button" className={cn(pill, 'text-ide-accent hover:text-ide-accent')} onClick={() => appStore.openProviders()}>
                <KeyRound size={13} />
                <span>{tr('无可用模型', 'No models')}</span>
            </button>
        )
    }
    const current = thread.state?.model
    const groups = new Map<string, PiModel[]>()
    for (const model of thread.models) {
        const list = groups.get(model.provider) ?? []
        list.push(model)
        groups.set(model.provider, list)
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={pill} disabled={!thread.models.length}>
                <Cpu size={13} />
                <span className="max-w-[180px] truncate">{current?.name ?? (thread.agentStatus === 'starting' ? tr('加载中…', 'Loading…') : tr('选择模型', 'Choose model'))}</span>
                <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 max-h-[420px]">
                {[...groups.entries()].map(([provider, models]) => (
                    <div key={provider}>
                        <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                        {models.map(model => (
                            <DropdownMenuItem key={`${provider}/${model.id}`} onSelect={() => void thread.setModel(model)}>
                                <span className="flex-1 truncate">{model.name}</span>
                                {model.contextWindow ? <span className="text-[11px] text-gray-400">{formatTokens(model.contextWindow)}</span> : null}
                                {current?.provider === model.provider && current.id === model.id && <Check size={14} className="text-ide-accent" />}
                            </DropdownMenuItem>
                        ))}
                    </div>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
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

/** Agents found on this machine, asked once per app run. */
let agentsQuery: Promise<AgentAvailability[]> | undefined
function useAgents(): AgentAvailability[] {
    const [agents, setAgents] = useState<AgentAvailability[]>([])
    useEffect(() => {
        let live = true
        agentsQuery ??= window.pi.listAgents().catch(() => [])
        void agentsQuery.then(list => live && setAgents(list))
        return () => {
            live = false
        }
    }, [])
    return agents
}

/** Which agent a fresh thread runs: pi, or an ACP agent (Codex, …). Gone once the thread has history. */
export const AgentPicker = observer(({ thread }: { thread: Thread }) => {
    const agents = useAgents()
    if (!thread.agentSwitchable && thread.agent === 'pi')
        return null
    const choices: { id: AgentKind, label: string, available: boolean, hint?: string }[] = [
        { id: 'pi', label: 'pi', available: true },
        ...agents.map(a => ({ id: a.id, label: a.label, available: a.available, hint: a.available ? a.command : a.error })),
    ]
    if (!thread.agentSwitchable || choices.length < 2) {
        // A thread of another agent keeps saying which one it is.
        return thread.agent === 'pi'
            ? null
            : <span className={cn(pill, 'pointer-events-none')}><Bot size={13} /><span>{thread.agentLabel}</span></span>
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={pill} title={tr('这个线程用哪个 Agent', 'Which agent runs this thread')} aria-label={tr(`Agent：${thread.agentLabel}`, `Agent: ${thread.agentLabel}`)}>
                <Bot size={13} />
                <span>{thread.agentLabel}</span>
                <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
                <DropdownMenuLabel>{tr('Agent', 'Agent')}</DropdownMenuLabel>
                {choices.map(choice => (
                    <DropdownMenuItem key={choice.id} disabled={!choice.available} onSelect={() => void thread.setAgent(choice.id)} className="h-auto items-start py-1.5">
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span>{choice.label}</span>
                            {choice.hint && <span className="text-[11.5px] break-all text-gray-500">{choice.hint}</span>}
                        </span>
                        {choice.id === thread.agent && <Check size={14} className="mt-0.5 text-ide-accent" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
})
