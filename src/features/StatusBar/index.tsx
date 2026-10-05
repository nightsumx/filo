// Bottom status bar, as in WebStorm: navigation breadcrumbs on the left, widgets on the right.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { APP_INFO } from '@shared/app'
import { cn, formatTokens } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Check, ChevronRight, Loader2, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { ProjectBadge } from '../Toolbar/ProjectBadge'

const widget = 'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-gray-600 outline-none hover:bg-black/[0.06] hover:text-gray-900 data-[state=open]:bg-black/[0.08]'

const THEMES = [
    { pref: 'system', label: '跟随系统', Icon: Monitor },
    { pref: 'light', label: '浅色', Icon: Sun },
    { pref: 'dark', label: '深色', Icon: Moon },
] as const

const ThemeMenu = observer(() => {
    const current = THEMES.find(t => t.pref === appStore.themePref) ?? THEMES[0]
    return (
        <DropdownMenu>
            <DropdownMenuTrigger aria-label={`外观：${current.label}`} title={`外观：${current.label}`} className={widget}>
                <current.Icon size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-36">
                {THEMES.map(({ pref, label, Icon }) => (
                    <DropdownMenuItem key={pref} onSelect={() => appStore.setTheme(pref)}>
                        <Icon size={14} />
                        {label}
                        {appStore.themePref === pref && <Check size={14} className="ml-auto !text-ide-accent" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
})

export const StatusBar = observer(() => {
    const project = appStore.project
    const thread = appStore.active
    const env = appStore.env
    const running = [...appStore.threads.values()].filter(t => t.running).length
    const model = thread?.state?.model
    const usage = thread?.stats?.contextUsage
    const percent = usage?.percent

    return (
        <footer className="flex h-[26px] shrink-0 items-center gap-0.5 px-2 text-[12px]">
            <nav aria-label="位置" className="flex min-w-0 flex-1 items-center gap-0.5">
                {project && (
                    <>
                        <span className={cn(widget, 'cursor-default')} title={project.cwd}>
                            <ProjectBadge name={project.name} size={12} className="rounded-[3px]" />
                            <span className="truncate">{project.name}</span>
                        </span>
                        {thread && (
                            <>
                                <ChevronRight size={12} className="shrink-0 text-gray-400" />
                                <span className={cn(widget, 'min-w-0 cursor-default')} title={thread.title}>
                                    <span className="truncate">{thread.isEmpty && !thread.persisted ? '新线程' : thread.title}</span>
                                </span>
                            </>
                        )}
                    </>
                )}
            </nav>
            {running > 0 && (
                <span className={cn(widget, 'cursor-default')}>
                    <Loader2 size={12} className="animate-spin" />
                    {`${running} 个线程运行中`}
                </span>
            )}
            {model && <span className={cn(widget, 'cursor-default')} title={`${model.provider}/${model.id}`}>{model.name}</span>}
            {usage?.contextWindow && (
                <span
                    className={cn(widget, 'cursor-default tabular-nums', percent != null && percent > 80 ? 'text-red-500' : percent != null && percent > 50 ? 'text-amber-600' : '')}
                    title="上下文用量"
                >
                    {`${percent == null ? '—' : `${Math.round(percent)}%`} / ${formatTokens(usage.contextWindow)}`}
                </span>
            )}
            <span className={cn(widget, 'cursor-default')} title={`${APP_INFO.name} ${__APP_VERSION__} · ${APP_INFO.tagline}`}>
                {env?.ok ? `pi ${env.env.version}` : env ? 'pi 不可用' : '正在查找 pi…'}
            </span>
            <ThemeMenu />
            <button type="button" className={widget} aria-label="设置" title="设置（⌘,）" onClick={() => appStore.setSettingsOpen(true)}>
                <Settings size={12} />
            </button>
        </footer>
    )
})
