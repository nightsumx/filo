// Card layout (rounded-3xl white card, toolbar row under the textarea, drag-over highlight) follows
// chat/src/features/ChatInput/index.tsx. Behavior is pi's: Enter sends, typing during a run steers,
// Esc aborts and restores queued messages, "/" opens extension commands, prompt templates and skills.
import type { ImageContent, SlashCommand } from '@shared/pi'
import type { Thread } from '@/store/thread'
import { ImageThumb } from '@/components/ImageView'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { terminalStore } from '@/store/terminals'
import { ArrowUp, Copy, ImagePlus, Square, SquareTerminal, Undo2, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { StatusLine } from '../Thread/StatusLine'
import { CacheNotice } from './CacheNotice'
import { AgentPicker, AutopilotToggle, ConfigPickers, installingAgentLabel, ModelPicker, ModePicker, NoModelNotice, ThinkingPicker } from './Pickers'
import { TodoBar } from './TodoBar'
import { tr } from '@/lib/i18n'
import { keys, os } from '@/platform'
import type { Localized } from '@shared/i18n'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** The last composer focus request each thread has taken (requests are numbered app-wide). */
const focusHandled = new WeakMap<Thread, number>()

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

/** pi's key for taking the queue back into the editor (app.message.dequeue). */
const dequeueKeys = os === 'windows' ? 'Alt+Q' : keys('⌥↑')

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
        <div ref={listRef} role="listbox" className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-lg border border-gray-200 light:border-transparent bg-elevated p-1 shadow-[0_6px_24px_rgba(0,0,0,0.18)] light:shadow-[shadow:var(--ide-float-shadow)]">
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

/** Where the composer would be, for a chat its agent continues only in a terminal (Cursor's own CLI chats). */
const TerminalOnly = observer(({ thread, command }: { thread: Thread, command: string }) => {
    const agent = thread.agentLabel
    return (
        <div className="mx-auto w-full max-w-5xl px-4 pb-3">
            <div role="status" className="flex flex-col gap-2 rounded-lg bg-ide-block px-3 py-2.5 text-[12.5px] text-gray-700">
                <span>
                    {tr(`这个对话是在终端里开的，${agent} 只允许在终端里接着聊，这里只能查看。`, `This chat was started in a terminal. ${agent} continues it only there; here it is read-only.`)}
                </span>
                <code className="block truncate font-mono text-[12px] text-gray-500 select-text" title={command}>{command}</code>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void terminalStore.create(thread.cwd, { command, label: agent })}
                        className="flex items-center gap-1.5 rounded-md bg-ide-accent px-2.5 py-1 text-[12px] text-always-white outline-none hover:bg-ide-accent-hover focus-visible:ring-2 focus-visible:ring-ide-accent/50"
                    >
                        <SquareTerminal size={13} />
                        {tr('在终端里继续', 'Continue in a terminal')}
                    </button>
                    <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(command).then(() => toast.success(tr('已复制命令', 'Command copied')))}
                        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] text-gray-700 outline-none hover:bg-ide-hover focus-visible:ring-2 focus-visible:ring-ide-accent/50"
                    >
                        <Copy size={13} />
                        {tr('复制命令', 'Copy command')}
                    </button>
                </div>
            </div>
        </div>
    )
})

export const Composer = observer(({ thread }: { thread: Thread }) => thread.terminalOnly ? <TerminalOnly thread={thread} command={thread.terminalOnly} /> : <ComposerEditor thread={thread} />)

const ComposerEditor = observer(({ thread }: { thread: Thread }) => {
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

    // Tab switches and new threads move keyboard focus here; clicks inside a pane do not. Each request
    // once: a thread that gets its session changes key, which must not take focus back from where the
    // user has moved it since (the terminal).
    const focusRequest = appStore.composerFocus
    useEffect(() => {
        if (focusRequest.key !== thread.key || focusHandled.get(thread) === focusRequest.n)
            return
        focusHandled.set(thread, focusRequest.n)
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

    // The agent picked for this fresh thread is still installing: typing is fine, sending waits.
    const installing = installingAgentLabel(thread)
    const hasInput = !!thread.draft.trim() || thread.images.length > 0
    const canSend = hasInput && !installing
    const agent = thread.agentLabel
    const queued = [
        ...thread.queue.steering.map(text => ({ kind: 'steering' as const, text })),
        ...thread.queue.followUp.map(text => ({ kind: 'followUp' as const, text })),
    ]
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
            if (canSend)
                void thread.send()
            return
        }
        if (e.key === 'Escape' && thread.running) {
            e.preventDefault()
            void thread.abort()
            return
        }
        // pi's app.message.dequeue: Alt+Up, Alt+Q on Windows.
        if (e.altKey && (os === 'windows' ? e.code === 'KeyQ' : e.key === 'ArrowUp') && queued.some(q => thread.unqueueable(q.kind))) {
            e.preventDefault()
            void thread.dequeueAll()
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
            <CacheNotice thread={thread} />
            {queued.length > 0 && (
                <div className="mb-2 flex flex-col gap-1">
                    {queued.map(({ kind, text }, i) => (
                        <div key={i} className="group flex items-center gap-2 rounded-md bg-ide-sel py-1 pr-1 pl-2.5 text-[12px] text-gray-800">
                            <span className="shrink-0 font-medium">{tr('排队中', 'Queued')}</span>
                            <span className="min-w-0 flex-1 truncate">{text}</span>
                            {thread.unqueueable(kind) && (
                                <button
                                    type="button"
                                    title={tr(`撤回到输入框（${dequeueKeys} 撤回全部）`, `Back to the editor (${dequeueKeys} takes back all)`)}
                                    aria-label={tr('撤回这条排队消息', 'Take back this queued message')}
                                    onClick={() => void thread.dequeue(kind, text)}
                                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 opacity-0 hover:bg-ide-hover hover:text-gray-900 focus-visible:opacity-100 group-hover:opacity-100"
                                >
                                    <Undo2 size={13} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <div className="relative">
                {slashMatches.length > 0 && <SlashMenu commands={slashMatches} active={slashIndex} onPick={pickCommand} />}
                <div
                    className={cn(
                        // A borderless filled field; focus changes nothing but the caret. Only a file
                        // drag shows an outline, as the drop target.
                        'relative cursor-text rounded-lg border border-transparent bg-ide-input transition-[border-color,background-color]',
                        dragOver && '!border-ide-accent !bg-ide-sel',
                    )}
                    onClick={e => e.target === e.currentTarget && textareaRef.current?.focus()}
                >
                    {thread.images.length > 0 && (
                        <div className="flex flex-wrap gap-2 px-3 pt-2.5">
                            {thread.images.map((_, i) => (
                                <div key={i} className="group relative">
                                    <ImageThumb images={thread.images} index={i} alt={tr('待发送图片', 'Image to send')} className="h-14 w-14 rounded-md border border-gray-200 object-cover" />
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
                        placeholder={installing ? tr(`正在安装 ${installing}，装好后就能发送`, `Installing ${installing}; you can send once it is ready`) : thread.running ? (queuesInput(thread) ? tr(`继续输入，${agent} 这轮结束后接着发送（Esc 中断）`, `Type a follow-up; ${agent} gets it after this run (Esc to stop)`) : tr(`继续输入以引导 ${agent}（Esc 中断）`, `Type to steer ${agent} (Esc to stop)`)) : thread.planMode ? tr(`描述要做的事，${agent} 先写出计划给你审阅`, `Describe the task; ${agent} writes a plan for you to review first`) : tr(`让 ${agent} 做点什么，输入 / 查看命令`, `Ask ${agent} to do something, or type / for commands`)}
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
                        <AutopilotToggle thread={thread} />
                        <ConfigPickers thread={thread} />
                        <span className="flex-1" />
                        {thread.running && !hasInput
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
                                        title={installing ? tr(`正在安装 ${installing}…`, `Installing ${installing}…`) : tr('发送（Enter）', 'Send (Enter)')}
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
