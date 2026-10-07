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
import { AgentPicker, ConfigPickers, ModelPicker, ModePicker, NoModelNotice, ThinkingPicker } from './Pickers'
import { TodoBar } from './TodoBar'
import { tr } from '@/lib/i18n'
import type { Localized } from '@shared/i18n'

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
    if (images.length && !thread.features.images) {
        toast.error(tr(`${thread.agentLabel} 不接受图片`, `${thread.agentLabel} does not take images`))
        return
    }
    for (const file of images) {
        if (file.size > MAX_IMAGE_BYTES) {
            toast.error(tr(`${file.name} 超过 8MB`, `${file.name} is larger than 8MB`))
            continue
        }
        const image = await readImage(file)
        thread.images = [...thread.images, image]
    }
}

/** ACP agents without steering take mid-run input as the next prompt. */
const queuesInput = (thread: Thread) => thread.agent !== 'pi' && !thread.state?.agentCaps?.steering

const SOURCE_LABEL: Record<SlashCommand['source'], Localized> = {
    extension: { zh: '扩展', en: 'extension' },
    prompt: { zh: '模板', en: 'prompt' },
    skill: { zh: '技能', en: 'skill' },
}

const SlashMenu = observer(function SlashMenu({ commands, active, onPick }: { commands: SlashCommand[], active: number, onPick: (c: SlashCommand) => void }) {
    const listRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }, [active])
    return (
        <div ref={listRef} role="listbox" className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-elevated p-1 shadow-[0_6px_24px_rgba(0,0,0,0.18)] light:shadow-[shadow:var(--ide-float-shadow)]">
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
                    <span className="shrink-0 text-[11px] text-gray-400">{SOURCE_LABEL[c.source] ? tr(SOURCE_LABEL[c.source]) : c.source}</span>
                </button>
            ))}
        </div>
    )
})

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
    const agent = thread.agentLabel
    const queued = [...thread.queue.steering, ...thread.queue.followUp]
    const widgetsAbove = Object.entries(thread.widgets).filter(([, w]) => w.placement === 'aboveEditor')
    const widgetsBelow = Object.entries(thread.widgets).filter(([, w]) => w.placement === 'belowEditor')
    const statuses = thread.visibleStatuses

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
                <pre key={key} className="mb-2 rounded-md bg-ide-block px-3 py-2 font-mono text-[12px] text-gray-600 whitespace-pre-wrap">{w.lines.join('\n')}</pre>
            ))}
            <TodoBar thread={thread} />
            <NoModelNotice thread={thread} />
            {queued.length > 0 && (
                <div className="mb-2 flex flex-col gap-1">
                    {queued.map((text, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md bg-ide-sel px-2.5 py-1 text-[12px] text-gray-800">
                            <span className="shrink-0 font-medium">{tr('排队中', 'Queued')}</span>
                            <span className="truncate">{text}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="relative">
                {slashMatches.length > 0 && <SlashMenu commands={slashMatches} active={slashIndex} onPick={pickCommand} />}
                <div
                    className={cn(
                        // A filled field (dark: borderless; light: white with a hairline and a faint drop);
                        // focus changes nothing but the caret. A file drag shows an accent outline, as
                        // the drop target.
                        'relative cursor-text rounded-lg border border-transparent bg-ide-input shadow-[shadow:var(--ide-input-shadow)] transition-[border-color,background-color] light:border-ide-border',
                        dragOver && '!border-ide-accent !bg-ide-sel',
                    )}
                    onClick={e => e.target === e.currentTarget && textareaRef.current?.focus()}
                >
                    {thread.images.length > 0 && (
                        <div className="flex flex-wrap gap-2 px-3 pt-2.5">
                            {thread.images.map((img, i) => (
                                <div key={i} className="group relative">
                                    <img src={`data:${img.mimeType};base64,${img.data}`} alt={tr('待发送图片', 'Image to send')} className="h-14 w-14 rounded-md border border-gray-200 object-cover" />
                                    <button
                                        type="button"
                                        aria-label={tr('移除图片', 'Remove image')}
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
                        aria-label={tr(`给 ${agent} 发消息`, `Message ${agent}`)}
                        placeholder={thread.running ? (queuesInput(thread) ? tr(`继续输入，${agent} 这轮结束后接着发送（Esc 中断）`, `Type a follow-up; ${agent} gets it after this run (Esc to stop)`) : tr(`继续输入以引导 ${agent}（Esc 中断）`, `Type to steer ${agent} (Esc to stop)`)) : thread.planMode ? tr(`描述要做的事，${agent} 先写出计划给你审阅`, `Describe the task; ${agent} writes a plan for you to review first`) : tr(`让 ${agent} 做点什么，输入 / 查看命令`, `Ask ${agent} to do something, or type / for commands`)}
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
                        {thread.features.images && (
                            <button
                                type="button"
                                aria-label={tr('添加图片', 'Add image')}
                                title={tr('添加图片', 'Add image')}
                                onClick={() => fileRef.current?.click()}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.06] hover:text-gray-800"
                            >
                                <ImagePlus size={14} />
                            </button>
                        )}
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
                        <AgentPicker thread={thread} />
                        <ModelPicker thread={thread} />
                        <ThinkingPicker thread={thread} />
                        <ModePicker thread={thread} />
                        <ConfigPickers thread={thread} />
                        <span className="flex-1" />
                        {thread.running && !canSend
                            ? (
                                    <button
                                        type="button"
                                        aria-label={tr('停止', 'Stop')}
                                        title={tr('停止（Esc）', 'Stop (Esc)')}
                                        onClick={() => void thread.abort()}
                                        className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                                    >
                                        <Square size={13} fill="currentColor" />
                                    </button>
                                )
                            : (
                                    <button
                                        type="button"
                                        aria-label={thread.running ? tr('发送引导消息', 'Send steering message') : tr('发送', 'Send')}
                                        disabled={!canSend}
                                        onClick={() => void thread.send()}
                                        title={tr('发送（Enter）', 'Send (Enter)')}
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
                            {thread.agentStatus === 'error' ? `${tr(`${agent} 启动失败：`, `${agent} failed to start: `)}${thread.agentError}` : tr(`${agent} 进程已退出，发送消息会重新启动。`, `${agent} has exited; sending a message starts it again.`)}
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
