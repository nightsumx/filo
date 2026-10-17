// "Skills and commands": the button that replaces typing "/" for a menu. A searchable list of what the agent
// reports (skills, prompt templates, an extension's or the agent's own commands) minus what the app has a control
// for (src/lib/guiCommands.ts). Picking one puts a chip above the draft; Thread.send writes `/name <draft>`,
// the text a terminal would have, so the agent sees the same thing in both.
import type { SlashCommand } from '@shared/pi'
import type { Thread } from '@/store/thread'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { pickable } from '@/lib/guiCommands'
import { tr } from '@/lib/i18n'
import { shortcutKeys } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Sparkles, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import type { Localized } from '@shared/i18n'

const GROUPS: { source: SlashCommand['source'], title: Localized }[] = [
    { source: 'skill', title: { zh: '技能', en: 'Skills' } },
    { source: 'prompt', title: { zh: '提示模板', en: 'Prompt templates' } },
    { source: 'extension', title: { zh: '扩展命令', en: 'Extension commands' } },
    { source: 'builtin', title: { zh: '命令', en: 'Commands' } },
]

const pill = 'flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-gray-600 outline-none transition-colors hover:bg-black/[0.06] hover:text-gray-900 data-[state=open]:bg-black/[0.08] disabled:opacity-50'

/** What the list shows for a search: a name or description containing every word. */
export function searchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return commands.filter((c) => {
        const text = `${c.name} ${c.description ?? ''}`.toLowerCase()
        return words.every(w => text.includes(w))
    })
}

export const CommandPicker = observer(({ thread }: { thread: Thread }) => {
    const [query, setQuery] = useState('')
    const [active, setActive] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    const commands = pickable(thread.commands)
    const shown = GROUPS.flatMap(g => searchCommands(commands.filter(c => c.source === g.source), query))

    useEffect(() => setActive(0), [query])
    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }, [active])

    // An agent with nothing to pick from (Codex reports no commands) has no button.
    if (!commands.length)
        return null

    const pick = (c: SlashCommand) => {
        thread.chip = c.name
        thread.pickerOpen = false
        setQuery('')
        appStore.focusComposer(thread.key)
    }
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.nativeEvent.isComposing)
            return
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (shown.length)
                setActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
        }
        else if (e.key === 'Enter' && shown[active]) {
            e.preventDefault()
            pick(shown[active])
        }
    }

    return (
        <Popover open={thread.pickerOpen} onOpenChange={open => (thread.pickerOpen = open)}>
            <PopoverTrigger className={pill} aria-label={tr('技能与命令', 'Skills and commands')} title={`${tr('技能与命令', 'Skills and commands')} (${shortcutKeys('commands')[0]})`}>
                <Sparkles size={13} />
                <span>{tr('技能', 'Skills')}</span>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-[380px] p-1.5" onCloseAutoFocus={(e) => { e.preventDefault() }}>
                <input
                    autoFocus
                    role="combobox"
                    aria-expanded
                    aria-controls="command-picker-list"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    aria-label={tr('搜索技能与命令', 'Search skills and commands')}
                    placeholder={tr('搜索技能与命令', 'Search skills and commands')}
                    className="mb-1 h-8 w-full rounded-md bg-ide-input px-2 text-[13px] text-gray-900 outline-none placeholder:text-gray-400"
                />
                <div ref={listRef} id="command-picker-list" role="listbox" className="max-h-72 overflow-y-auto">
                    {shown.length === 0 && (
                        <div className="px-2 py-3 text-[12px] text-gray-500">{query ? tr('没有匹配的', 'Nothing matches') : tr('还没有技能，到设置 → 技能里添加', 'No skills yet; add some in Settings → Skills')}</div>
                    )}
                    {GROUPS.map((g) => {
                        const items = searchCommands(commands.filter(c => c.source === g.source), query)
                        if (!items.length)
                            return null
                        return (
                            <div key={g.source} role="group" aria-label={tr(g.title)}>
                                <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-gray-400">{tr(g.title)}</div>
                                {items.map((c) => {
                                    const index = shown.indexOf(c)
                                    return (
                                        <button
                                            key={`${c.source}:${c.name}`}
                                            type="button"
                                            role="option"
                                            aria-selected={index === active}
                                            data-active={index === active}
                                            onMouseMove={() => setActive(index)}
                                            onClick={() => pick(c)}
                                            className={cn('flex min-h-7 w-full flex-col items-start rounded-md px-2 py-1 text-left', index === active ? 'bg-ide-sel' : 'hover:bg-ide-hover')}
                                        >
                                            <span className="font-mono text-[12.5px] text-gray-900">{c.name}</span>
                                            {c.description && <span className="line-clamp-2 text-[12px] text-gray-500">{c.description}</span>}
                                        </button>
                                    )
                                })}
                            </div>
                        )
                    })}
                </div>
            </PopoverContent>
        </Popover>
    )
})

/** The picked command above the draft; Backspace in an empty draft or the cross takes it back. */
export const CommandChip = observer(({ thread }: { thread: Thread }) => {
    if (!thread.chip)
        return null
    return (
        <div className="flex px-3 pt-2.5">
            <span data-command-chip={thread.chip} className="flex h-6 items-center gap-1 rounded-md bg-ide-sel pr-1 pl-2 font-mono text-[12.5px] text-gray-900">
                {thread.chip}
                <button
                    type="button"
                    aria-label={tr('去掉这个命令', 'Remove this command')}
                    onClick={() => (thread.chip = null)}
                    className="flex h-4 w-4 items-center justify-center rounded text-gray-500 hover:bg-ide-hover hover:text-gray-900"
                >
                    <X size={11} />
                </button>
            </span>
        </div>
    )
})
