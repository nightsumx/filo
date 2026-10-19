// Browser tool window, an island to the right of the editor: one tab per page of the shown project,
// an address bar, and the page itself. The page is a native view that main lays over this window
// (electron/browsers.ts); this panel only says where. A page opened by an agent shows here as it
// works, so the user can watch, log in, or take over.
import type { BrowserTabInfo } from '@shared/ipc'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { browserStore, MIN_WIDTH } from '@/store/browser'
import { keys } from '@/platform'
import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, Plus, RotateCw, SquareDashedMousePointer, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'

const api = () => window.pi

const headerBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 outline-none hover:bg-black/[0.06] hover:text-gray-800 disabled:pointer-events-none disabled:opacity-40'

/** Things drawn over the page that the native view would cover: dialogs, menus, popovers. Tooltips are small and above the buttons. */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'

function overlapping(rect: DOMRect): boolean {
    for (const el of document.querySelectorAll(OVERLAYS)) {
        if (el.querySelector('[role="tooltip"]') && !el.querySelector('[role="menu"], [role="dialog"], [role="listbox"]'))
            continue
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top)
            return true
    }
    return false
}

const label = (tab: BrowserTabInfo) => tab.title || (tab.url ? tab.url.replace(/^https?:\/\//, '') : tr('新标签页', 'New tab'))

const Tab = observer(({ info, active }: { info: BrowserTabInfo, active: boolean }) => (
    <div
        role="tab"
        aria-selected={active}
        title={`${label(info)}${info.by === 'agent' ? tr(' · Agent 打开', ' · opened by the agent') : ''}`}
        className={cn(
            'group flex h-6 min-w-0 max-w-[160px] shrink-0 cursor-default items-center gap-1.5 rounded-md pl-2 pr-1 text-[12px]',
            active ? 'bg-ide-tab text-gray-900 shadow-[shadow:var(--ide-tab-shadow)]' : 'text-gray-600 hover:bg-ide-hover',
        )}
        onMouseDown={(e) => {
            // Middle click closes, as with editor tabs.
            if (e.button === 1) {
                e.preventDefault()
                void browserStore.close(info.id)
            }
        }}
        onClick={() => browserStore.select(info.id)}
    >
        {info.by === 'agent'
            ? <Bot size={12} className={cn('shrink-0', info.busy ? 'text-ide-accent' : 'text-gray-500')} />
            : <Globe size={12} className="shrink-0 text-gray-500" />}
        <span className="truncate">{label(info)}</span>
        <button
            type="button"
            aria-label={tr('关闭标签页', 'Close tab')}
            onClick={(e) => {
                e.stopPropagation()
                void browserStore.close(info.id)
            }}
            className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-black/[0.08] hover:text-gray-800', !active && 'opacity-0 group-hover:opacity-100')}
        >
            <X size={11} />
        </button>
    </div>
))

/** The address field: shows the page's URL until the user types in it. */
const Address = observer(({ tab }: { tab: BrowserTabInfo }) => {
    const input = useRef<HTMLInputElement>(null)
    const [draft, setDraft] = useState<string | null>(null)
    const handled = useRef(browserStore.addressRequest)
    useEffect(() => {
        if (browserStore.addressRequest === handled.current)
            return
        handled.current = browserStore.addressRequest
        input.current?.focus()
    }, [browserStore.addressRequest])
    // A blank tab made for typing opens with the cursor in the field.
    useEffect(() => {
        if (!tab.url && !tab.loading)
            input.current?.focus()
    }, [tab.id])
    return (
        <input
            ref={input}
            value={draft ?? tab.url}
            spellCheck={false}
            aria-label={tr('地址', 'Address')}
            placeholder={tr('输入网址，或 localhost:端口', 'Enter an address, or localhost:port')}
            onChange={e => setDraft(e.target.value)}
            onFocus={e => e.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && draft !== null) {
                    void browserStore.navigate(tab.id, draft)
                    setDraft(null)
                    e.currentTarget.blur()
                }
                else if (e.key === 'Escape') {
                    setDraft(null)
                    e.currentTarget.blur()
                }
            }}
            className="h-6 min-w-0 flex-1 rounded-md bg-ide-hover px-2 text-[12px] text-gray-900 outline-none placeholder:text-gray-500"
        />
    )
})

/**
 * Where the page goes. Reports the host's rectangle to main whenever it moves or changes size (a
 * layout change that shifts it without resizing is why this polls each frame instead of observing),
 * and steps aside while something is drawn over it.
 */
const PageHost = observer(({ tab }: { tab: BrowserTabInfo }) => {
    const host = useRef<HTMLDivElement>(null)
    const blank = !tab.url && !tab.loading
    const wanted = !blank && !browserStore.resizing
    useEffect(() => {
        const el = host.current
        if (!el)
            return
        let frame = 0
        let last = ''
        let dirty = true
        let covered = false
        const observer = new MutationObserver((records) => {
            for (const r of records) {
                if (r.type === 'childList' || (r.target instanceof Element && r.target.closest('[data-radix-popper-content-wrapper]')))
                    dirty = true
            }
        })
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-state'] })
        const tick = () => {
            const rect = el.getBoundingClientRect()
            if (dirty) {
                dirty = false
                covered = overlapping(rect)
            }
            const shown = wanted && !covered && rect.width > 0 && rect.height > 0
            const key = shown ? `${rect.x},${rect.y},${rect.width},${rect.height}` : ''
            if (key !== last) {
                last = key
                api().browserShow(shown ? tab.id : null, shown ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined)
            }
            frame = requestAnimationFrame(tick)
        }
        tick()
        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
            api().browserShow(null)
        }
    }, [tab.id, wanted])
    return (
        <div ref={host} className="relative min-h-0 flex-1">
            {blank && (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-gray-500">
                    <Globe size={22} className="text-gray-400" />
                    <span>{tr('在上面输入网址，或 localhost:端口', 'Type an address above, or localhost:port')}</span>
                    <span className="text-[12px] text-gray-400">{tr('Agent 打开的页面也会出现在这里，你可以随时接手。', 'Pages an agent opens show up here too, and you can take over any time.')}</span>
                </div>
            )}
        </div>
    )
})

export const BrowserPanel = observer(() => {
    const tabs = browserStore.tabs
    const active = browserStore.active
    return (
        <section aria-label={tr('浏览器', 'Browser')} className="flex h-full w-full flex-col bg-ide-panel">
            <div className="flex h-[32px] shrink-0 items-center gap-1 pl-3 pr-1.5">
                <span className="mr-1 text-[13px] font-semibold text-gray-900">{tr('浏览器', 'Browser')}</span>
                <div role="tablist" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
                    {tabs.map(t => <Tab key={t.id} info={t} active={t.id === active?.id} />)}
                </div>
                <button type="button" aria-label={tr('新标签页', 'New tab')} title={tr('新标签页', 'New tab')} onClick={() => void browserStore.create()} className={headerBtn}>
                    <Plus size={14} />
                </button>
                <span className="flex-1" />
                <button type="button" aria-label={tr('隐藏浏览器', 'Hide browser')} title={tr(`隐藏（${keys('⌘⇧B')}）`, `Hide (${keys('⌘⇧B')})`)} onClick={browserStore.hide} className={headerBtn}>
                    <X size={14} />
                </button>
            </div>
            {active && (
                <>
                    <div className="flex h-[30px] shrink-0 items-center gap-0.5 pl-2.5 pr-1.5">
                        <button type="button" aria-label={tr('后退', 'Back')} title={tr('后退', 'Back')} disabled={!active.canGoBack} onClick={() => api().browserGo(active.id, 'back')} className={headerBtn}>
                            <ArrowLeft size={14} />
                        </button>
                        <button type="button" aria-label={tr('前进', 'Forward')} title={tr('前进', 'Forward')} disabled={!active.canGoForward} onClick={() => api().browserGo(active.id, 'forward')} className={headerBtn}>
                            <ArrowRight size={14} />
                        </button>
                        <button type="button" aria-label={active.loading ? tr('停止加载', 'Stop loading') : tr('重新载入', 'Reload')} title={active.loading ? tr('停止加载', 'Stop loading') : tr('重新载入', 'Reload')} disabled={!active.url && !active.loading} onClick={() => api().browserGo(active.id, active.loading ? 'stop' : 'reload')} className={cn(headerBtn, 'mr-1')}>
                            {active.loading ? <X size={14} /> : <RotateCw size={13} />}
                        </button>
                        <Address key={active.id} tab={active} />
                        <button type="button" aria-label={tr('用系统浏览器打开', 'Open in your browser')} title={tr('用系统浏览器打开', 'Open in your browser')} disabled={!active.url} onClick={() => void api().openExternal(active.url)} className={cn(headerBtn, 'ml-1')}>
                            <ExternalLink size={13} />
                        </button>
                        <button type="button" aria-label={tr('开发者工具', 'Developer tools')} title={tr('开发者工具', 'Developer tools')} disabled={!active.url} onClick={() => api().browserDevTools(active.id)} className={headerBtn}>
                            <SquareDashedMousePointer size={14} />
                        </button>
                    </div>
                    {/* The agent is acting in this tab. */}
                    <div className={cn('h-px shrink-0', active.busy ? 'animate-pulse bg-ide-accent' : 'bg-transparent')} />
                    <PageHost key={active.id} tab={active} />
                </>
            )}
        </section>
    )
})

/** The gap left of the panel; dragging it sets the width. */
export const BrowserResizer = observer(({ maxWidth }: { maxWidth: () => number }) => {
    const onPointerDown = (e: React.PointerEvent) => {
        e.preventDefault()
        const target = e.currentTarget as HTMLElement
        target.setPointerCapture(e.pointerId)
        const startX = e.clientX
        const start = browserStore.width
        browserStore.resizing = true
        const move = (ev: PointerEvent) => browserStore.setWidth(Math.min(maxWidth(), start + startX - ev.clientX))
        const up = () => {
            browserStore.resizing = false
            target.removeEventListener('pointermove', move)
            target.removeEventListener('pointerup', up)
        }
        target.addEventListener('pointermove', move)
        target.addEventListener('pointerup', up)
    }
    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={tr('调整浏览器宽度', 'Resize browser')}
            aria-valuemin={MIN_WIDTH}
            aria-valuenow={browserStore.width}
            className="-mx-[5px] w-[5px] shrink-0 cursor-col-resize"
            onPointerDown={onPointerDown}
        />
    )
})
