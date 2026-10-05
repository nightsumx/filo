// Card layout (rounded-3xl white card, toolbar row under the textarea, drag-over highlight) follows
// chat/src/features/ChatInput/index.tsx. Behavior is pi's: Enter sends, typing during a run steers,
// Esc aborts and restores queued messages, "/" opens extension commands, prompt templates and skills.
import type { ImageContent, SlashCommand } from '@shared/pi'
import type { Thread } from '@/store/thread'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { StatusLine } from '../Thread/StatusLine'
import { ModelPicker, ThinkingPicker } from './Pickers'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function readImage(file: File): Promise<ImageContent> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const [, data] = String(reader.result).split(',')
            resolve({ type: 'image', data, mimeType: file.type || 'image/png' })
        }
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
    })
}

async function addImages(thread: Thread, files: File[]) {
    const images = files.filter(f => f.type.startsWith('image/'))
    for (const file of images) {
        if (file.size > MAX_IMAGE_BYTES) {
            toast.error(`${file.name} 超过 8MB`)
            continue
        }
        const image = await readImage(file)
        thread.images = [...thread.images, image]
    }
}

const sourceLabel: Record<SlashCommand['source'], string> = { extension: '扩展', prompt: '模板', skill: '技能' }

function SlashMenu({ commands, active, onPick }: { commands: SlashCommand[], active: number, onPick: (c: SlashCommand) => void }) {
    const listRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }, [active])
    return (
        <div ref={listRef} role="listbox" className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-elevated p-1 shadow-[0_6px_24px_rgba(0,0,0,0.18)]">
            {commands.map((c, i) => (
                <button
                    key={`${c.source}:${c.name}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    onMouseDown={(e) => {
                        e.preventDefault()
                        onPick(c)
                    }}
                    className={cn('flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]', i === active ? 'bg-ide-sel' : 'hover:bg-ide-hover')}
                >
                    <span className="font-mono text-[12.5px] text-gray-900">{`/${c.name}`}</span>
                    <span className="min-w-0 flex-1 truncate text-gray-500">{c.description}</span>
                    <span className="shrink-0 text-[11px] text-gray-400">{sourceLabel[c.source] ?? c.source}</span>
                </button>
            ))}
        </div>
    )
}

export const Composer = observer(({ thread }: { thread: Thread }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const fileRef = useRef<HTMLInputElement>(null)
    const [dragOver, setDragOver] = useState(false)
    const [slashIndex, setSlashIndex] = useState(0)
    const [slashDismissed, setSlashDismissed] = useState(false)

    const slashQuery = /^\/(\S*)$/.exec(thread.draft)?.[1]
    const slashMatches = slashQuery == null || slashDismissed
        ? []
        : thread.commands.filter(c => c.name.toLowerCase().includes(slashQuery.toLowerCase())).slice(0, 50)

    useEffect(() => {
        setSlashIndex(0)
    }, [slashQuery])

    // Tab switches and new threads move keyboard focus here; clicks inside a pane do not.
    const focusRequest = appStore.composerFocus
    useEffect(() => {
        if (focusRequest.key === thread.key)
            textareaRef.current?.focus()
    }, [focusRequest.n, focusRequest.key, thread.key])

    // Auto-grow up to 40% of the window, then scroll.
    useLayoutEffect(() => {
        const el = textareaRef.current
        if (!el)
            return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
    }, [thread.draft])

    const canSend = !!thread.draft.trim() || thread.images.length > 0
    const queued = [...thread.queue.steering, ...thread.queue.followUp]
    const widgetsAbove = Object.entries(thread.widgets).filter(([, w]) => w.placement === 'aboveEditor')
    const widgetsBelow = Object.entries(thread.widgets).filter(([, w]) => w.placement === 'belowEditor')
    const statuses = Object.entries(thread.statuses)

    const pickCommand = (c: SlashCommand) => {
        thread.draft = `/${c.name} `
        setSlashDismissed(true)
        textareaRef.current?.focus()
    }

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing)
            return
        if (slashMatches.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setSlashIndex(i => (i + step + slashMatches.length) % slashMatches.length)
                return
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault()
                pickCommand(slashMatches[slashIndex] ?? slashMatches[0])
                return
            }
            if (e.key === 'Escape') {
                e.preventDefault()
                setSlashDismissed(true)
                return
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            setSlashDismissed(false)
            void thread.send()
            return
        }
        if (e.key === 'Escape' && thread.running) {
            e.preventDefault()
            void thread.abort()
        }
    }

    return (
        <div
            className="mx-auto w-full max-w-5xl px-4 pb-3"
            onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files'))
                    return
                e.preventDefault()
                setDragOver(true)
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setDragOver(false)
            }}
            onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                void addImages(thread, Array.from(e.dataTransfer.files))
            }}
        >
            {widgetsAbove.map(([key, w]) => (
                <pre key={key} className="mb-2 rounded-md bg-[var(--bg-side)] px-3 py-2 font-mono text-[12px] text-gray-600 whitespace-pre-wrap">{w.lines.join('\n')}</pre>
            ))}
            {queued.length > 0 && (
                <div className="mb-2 flex flex-col gap-1">
                    {queued.map((text, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md bg-ide-sel px-2.5 py-1 text-[12px] text-gray-800">
                            <span className="shrink-0 font-medium">排队中</span>
                            <span className="truncate">{text}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="relative">
                {slashMatches.length > 0 && <SlashMenu commands={slashMatches} active={slashIndex} onPick={pickCommand} />}
                <div
                    className={cn(
                        // Light: a borderless filled field. Dark: JetBrains text field with a 1px border.
                        // Both turn into a 2px accent ring on focus.
                        'relative cursor-text rounded-lg border border-transparent bg-gray-50 transition-[border-color,box-shadow,background-color] dark:border-gray-200 dark:bg-ide-editor',
                        'focus-within:bg-ide-editor',
                        'focus-within:border-ide-accent focus-within:shadow-[0_0_0_1px_var(--ide-accent)]',
                        dragOver && '!border-ide-accent !bg-ide-sel',
                    )}
                    onClick={e => e.target === e.currentTarget && textareaRef.current?.focus()}
                >
                    {thread.images.length > 0 && (
                        <div className="flex flex-wrap gap-2 px-3 pt-2.5">
                            {thread.images.map((img, i) => (
                                <div key={i} className="group relative">
                                    <img src={`data:${img.mimeType};base64,${img.data}`} alt="待发送图片" className="h-14 w-14 rounded-md border border-gray-200 object-cover" />
                                    <button
                                        type="button"
                                        aria-label="移除图片"
                                        onClick={() => (thread.images = thread.images.filter((_, j) => j !== i))}
                                        className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-gray-800 text-white group-hover:flex"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <textarea
                        ref={textareaRef}
                        value={thread.draft}
                        rows={2}
                        aria-label="给 pi 发消息"
                        placeholder={thread.running ? '继续输入以引导 pi（Esc 中断）' : '让 pi 做点什么，输入 / 查看命令'}
                        onChange={(e) => {
                            thread.draft = e.target.value
                            setSlashDismissed(false)
                        }}
                        onKeyDown={onKeyDown}
                        onPaste={(e) => {
                            const files = Array.from(e.clipboardData.files)
                            if (files.some(f => f.type.startsWith('image/'))) {
                                e.preventDefault()
                                void addImages(thread, files)
                            }
                        }}
                        className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[length:var(--app-font-size)] leading-relaxed text-gray-900 outline-none placeholder:text-gray-400 select-text"
                    />
                    <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
                        <button
                            type="button"
                            aria-label="添加图片"
                            title="添加图片"
                            onClick={() => fileRef.current?.click()}
                            className="flex h-6 w-6 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800"
                        >
                            <ImagePlus size={14} />
                        </button>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            multiple
                            hidden
                            onChange={(e) => {
                                void addImages(thread, Array.from(e.target.files ?? []))
                                e.target.value = ''
                            }}
                        />
                        <ModelPicker thread={thread} />
                        <ThinkingPicker thread={thread} />
                        <span className="flex-1" />
                        {thread.running && !canSend
                            ? (
                                    <button
                                        type="button"
                                        aria-label="停止"
                                        title="停止（Esc）"
                                        onClick={() => void thread.abort()}
                                        className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                                    >
                                        <Square size={13} fill="currentColor" />
                                    </button>
                                )
                            : (
                                    <button
                                        type="button"
                                        aria-label={thread.running ? '发送引导消息' : '发送'}
                                        disabled={!canSend}
                                        onClick={() => void thread.send()}
                                        title="发送（Enter）"
                                        className="ml-1 flex h-7 w-7 items-center justify-center rounded-md bg-ide-accent text-always-white hover:bg-ide-accent-hover disabled:bg-gray-100 disabled:text-gray-400"
                                    >
                                        <ArrowUp size={15} />
                                    </button>
                                )}
                    </div>
                </div>
            </div>

            <StatusLine thread={thread} />

            {(statuses.length > 0 || widgetsBelow.length > 0 || thread.agentStatus === 'error' || thread.agentStatus === 'exited') && (
                <div className="mt-1.5 flex flex-col gap-1 px-2 text-[11.5px] text-gray-500">
                    {(thread.agentStatus === 'error' || thread.agentStatus === 'exited') && (
                        <span className="text-red-500 whitespace-pre-wrap">
                            {thread.agentStatus === 'error' ? `pi 启动失败：${thread.agentError}` : 'pi 进程已退出，发送消息会重新启动。'}
                        </span>
                    )}
                    {statuses.length > 0 && (
                        <div className="flex flex-wrap gap-x-3">
                            {statuses.map(([key, text]) => <span key={key}>{text}</span>)}
                        </div>
                    )}
                    {widgetsBelow.map(([key, w]) => (
                        <pre key={key} className="font-mono whitespace-pre-wrap">{w.lines.join('\n')}</pre>
                    ))}
                </div>
            )}
        </div>
    )
})
