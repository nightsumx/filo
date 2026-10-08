// Terminal tool window, under the editor island as in JetBrains IDEs: one tab per terminal of the
// shown project, the front one's xterm below. ⌃` opens and focuses it, and hides it from inside.
import type { TerminalInfo } from '@shared/ipc'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { MIN_HEIGHT, terminalStore } from '@/store/terminals'
import { Bot, ChevronDown, Copy, Eraser, MessageSquarePlus, Plus, RotateCw, X } from 'lucide-react'
import { reaction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef } from 'react'
import { existingView, pruneViews, viewOf } from './views'
import { keys, terminalCommand, terminalKeys } from '@/platform'

const headerBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 outline-none hover:bg-black/[0.06] hover:text-gray-800'

/** Last focus request a terminal took; a tab shown for another reason (project switch) leaves focus alone. */
let focusHandled = 0

/** Keeps views only for terminals that still exist in projects this window shows. */
export function useTerminalViews() {
    useEffect(() => reaction(
        () => terminalStore.list.filter(t => appStore.windowProjects.includes(t.cwd)).map(t => t.id),
        (ids) => {
            const keep = new Set(ids)
            pruneViews(id => keep.has(id))
        },
    ), [])
}

const Tab = observer(({ info, active }: { info: TerminalInfo, active: boolean }) => {
    const failed = info.exit && info.exit.code !== 0
    const state = info.exit
        ? tr(`已退出（${info.exit.code}）`, `Exited (${info.exit.code})`)
        : info.busy ? tr('运行中', 'Running') : tr('空闲', 'Idle')
    return (
        <div
            role="tab"
            aria-selected={active}
            title={`${info.command ?? info.title} · ${state}${info.by === 'agent' ? tr(' · Agent 启动', ' · started by the agent') : ''}`}
            className={cn(
                'group flex h-6 min-w-0 max-w-[200px] shrink-0 cursor-default items-center gap-1.5 rounded-md pl-2 pr-1 text-[12px]',
                active ? 'bg-ide-tab text-gray-900 shadow-[shadow:var(--ide-tab-shadow)]' : 'text-gray-600 hover:bg-ide-hover',
            )}
            onMouseDown={(e) => {
                // Middle click closes, as with editor tabs.
                if (e.button === 1) {
                    e.preventDefault()
                    void terminalStore.close(info.id)
                }
            }}
            onClick={() => terminalStore.select(info.id)}
        >
            {info.by === 'agent'
                ? <Bot size={12} className="shrink-0 text-gray-500" />
                : <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', info.busy ? 'bg-[#99d58f]' : failed ? 'bg-amber-500' : 'bg-gray-400/60')} />}
            <span className="truncate">{info.title}</span>
            {info.exit && <span className={cn('shrink-0 font-mono text-[11px]', failed ? 'text-amber-600' : 'text-gray-500')}>{info.exit.code}</span>}
            <button
                type="button"
                aria-label={tr(`关闭终端 ${info.title}`, `Close terminal ${info.title}`)}
                title={tr(`关闭（${terminalKeys('W')}）`, `Close (${terminalKeys('W')})`)}
                onClick={(e) => {
                    e.stopPropagation()
                    void terminalStore.close(info.id)
                }}
                className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-black/[0.08] hover:text-gray-800', !active && 'opacity-0 group-hover:opacity-100')}
            >
                <X size={11} />
            </button>
        </div>
    )
})

/** The front terminal's xterm, moved into this host; refitted whenever the host changes size. */
const TerminalBody = observer(({ info }: { info: TerminalInfo }) => {
    const host = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const el = host.current
        if (!el)
            return
        const view = viewOf(info.id)
        view.mount(el)
        let frame = 0
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                view.fit()
                terminalStore.lastSize = view.size
            })
        })
        observer.observe(el)
        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
            view.unmount()
        }
    }, [info.id])
    useEffect(() => {
        if (terminalStore.focusRequest === focusHandled)
            return
        focusHandled = terminalStore.focusRequest
        existingView(info.id)?.focus()
    }, [info.id, terminalStore.focusRequest])

    const send = async () => {
        const view = existingView(info.id)
        if (view)
            terminalStore.sendToThread(await view.text())
    }
    const hasThread = !!appStore.active

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div className="min-h-0 flex-1 py-1 pl-3 pr-1">
                    <div ref={host} className="h-full w-full" />
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
                <ContextMenuItem onSelect={() => document.execCommand('copy')}>
                    <Copy size={14} />
                    {tr('复制', 'Copy')}
                    <span className="ml-auto text-[11px] text-gray-500">{terminalKeys('C')}</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => existingView(info.id)?.term.clear()}>
                    <Eraser size={14} />
                    {tr('清屏', 'Clear')}
                    <span className="ml-auto text-[11px] text-gray-500">{terminalKeys('K')}</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={!hasThread} onSelect={() => void send()}>
                    <MessageSquarePlus size={14} />
                    {existingView(info.id)?.term.hasSelection() ? tr('选中内容发给线程', 'Send selection to thread') : tr('输出发给线程', 'Send output to thread')}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    )
})

export const TerminalPanel = observer(() => {
    const tabs = terminalStore.tabs
    const active = terminalStore.active
    const project = terminalStore.project

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!terminalCommand(e) || !active)
            return
        const key = e.key.toLowerCase()
        // Inside the terminal these act on terminals, not on threads.
        if (key === 'w') {
            void terminalStore.close(active.id)
        }
        else if (key === 't' && project) {
            void terminalStore.create(project)
        }
        else if (key === 'k') {
            existingView(active.id)?.term.clear()
        }
        // Copy and paste: the Edit menu has them on macOS (so these never fire there), Ctrl+Shift+C/V elsewhere.
        else if (key === 'c') {
            document.execCommand('copy')
        }
        else if (key === 'v') {
            const view = existingView(active.id)
            void navigator.clipboard.readText().then(text => text && view?.term.paste(text))
        }
        else {
            return
        }
        e.preventDefault()
        e.stopPropagation()
    }

    return (
        <section aria-label={tr('终端', 'Terminal')} className="flex h-full w-full flex-col bg-ide-panel" onKeyDown={onKeyDown}>
            <div className="flex h-[32px] shrink-0 items-center gap-1 pl-3 pr-1.5">
                <span className="mr-1 text-[13px] font-semibold text-gray-900">{tr('终端', 'Terminal')}</span>
                <div role="tablist" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
                    {tabs.map(t => <Tab key={t.id} info={t} active={t.id === active?.id} />)}
                </div>
                <button type="button" aria-label={tr('新终端', 'New terminal')} title={tr(`新终端（${terminalKeys('T')}）`, `New terminal (${terminalKeys('T')})`)} disabled={!project} onClick={() => project && void terminalStore.create(project)} className={headerBtn}>
                    <Plus size={14} />
                </button>
                <span className="flex-1" />
                {active?.command && (
                    <button type="button" aria-label={tr('重新运行', 'Run again')} title={`${tr('重新运行', 'Run again')}: ${active.command}`} onClick={() => void terminalStore.restart(active.id)} className={headerBtn}>
                        <RotateCw size={13} />
                    </button>
                )}
                <button type="button" aria-label={tr('隐藏终端', 'Hide terminal')} title={tr(`隐藏（${keys('⌃`')}）`, `Hide (${keys('⌃`')})`)} onClick={terminalStore.hide} className={headerBtn}>
                    <ChevronDown size={15} />
                </button>
            </div>
            {active && <TerminalBody key={active.id} info={active} />}
        </section>
    )
})

/** The gap above the tool window; dragging it sets the height. */
export const TerminalResizer = observer(({ maxHeight }: { maxHeight: () => number }) => {
    const onPointerDown = (e: React.PointerEvent) => {
        e.preventDefault()
        const target = e.currentTarget as HTMLElement
        target.setPointerCapture(e.pointerId)
        const startY = e.clientY
        const start = terminalStore.height
        const move = (ev: PointerEvent) => terminalStore.setHeight(Math.min(maxHeight(), start + startY - ev.clientY))
        const up = () => {
            target.removeEventListener('pointermove', move)
            target.removeEventListener('pointerup', up)
        }
        target.addEventListener('pointermove', move)
        target.addEventListener('pointerup', up)
    }
    return (
        <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={tr('调整终端高度', 'Resize terminal')}
            aria-valuemin={MIN_HEIGHT}
            aria-valuenow={terminalStore.height}
            className="h-[5px] shrink-0 cursor-row-resize"
            onPointerDown={onPointerDown}
        />
    )
})
