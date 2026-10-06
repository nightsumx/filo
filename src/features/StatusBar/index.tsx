// Bottom status bar, as in WebStorm: navigation breadcrumbs on the left, widgets on the right.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { APP_INFO } from '@shared/app'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Check, ChevronRight, Loader2, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { ProjectBadge } from '../Toolbar/ProjectBadge'
import { newThreadLabel, tr } from '@/lib/i18n'

const widget = 'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-gray-600 outline-none hover:bg-black/[0.06] hover:text-gray-900 data-[state=open]:bg-black/[0.08]'

const THEMES = [
    { pref: 'system', label: { zh: '跟随系统', en: 'System' }, Icon: Monitor },
    { pref: 'light', label: { zh: '浅色', en: 'Light' }, Icon: Sun },
    { pref: 'dark', label: { zh: '深色', en: 'Dark' }, Icon: Moon },
] as const

const ThemeMenu = observer(() => {
    const current = THEMES.find(t => t.pref === appStore.themePref) ?? THEMES[0]
    return (
        <DropdownMenu>
            <DropdownMenuTrigger aria-label={`${tr('外观：', 'Appearance: ')}${tr(current.label)}`} title={`${tr('外观：', 'Appearance: ')}${tr(current.label)}`} className={widget}>
                <current.Icon size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-36">
                {THEMES.map(({ pref, label, Icon }) => (
                    <DropdownMenuItem key={pref} onSelect={() => appStore.setTheme(pref)}>
                        <Icon size={14} />
                        {tr(label)}
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

    return (
        <footer className="flex h-[26px] shrink-0 items-center gap-0.5 px-2 text-[12px]">
            <nav aria-label={tr('位置', 'Location')} className="flex min-w-0 flex-1 items-center gap-0.5">
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
                                    <span className="truncate">{thread.isEmpty && !thread.persisted ? newThreadLabel() : thread.title}</span>
                                </span>
                            </>
                        )}
                    </>
                )}
            </nav>
            {running > 0 && (
                <span className={cn(widget, 'cursor-default')}>
                    <Loader2 size={12} className="animate-spin" />
                    {tr(`${running} 个线程运行中`, `${running} running`)}
                </span>
            )}
            <span className={cn(widget, 'cursor-default')} title={`${APP_INFO.name} ${__APP_VERSION__} · ${tr(APP_INFO.tagline)}`}>
                {env?.ok ? `pi ${env.env.version}` : env ? tr('pi 不可用', 'pi unavailable') : tr('正在查找 pi…', 'Looking for pi…')}
            </span>
            <ThemeMenu />
            <button type="button" className={widget} aria-label={tr('设置', 'Settings')} title={tr('设置（⌘,）', 'Settings (⌘,)')} onClick={() => appStore.setSettingsOpen(true)}>
                <Settings size={12} />
            </button>
        </footer>
    )
})
