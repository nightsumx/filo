// Inline answer form for pi's extension UI sub-protocol (select / confirm / input / editor). It sits in
// the transcript where the working indicator would be, so a blocked run reads as part of the thread.
import type { Thread, UiRequest } from '@/store/thread'
import { Button } from '@/components/ui/button'
import { flatFieldClass } from '@/components/ui/form'
import { useT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { Gutter } from './ToolRow'

type Payload = { value?: string, confirmed?: boolean, cancelled?: boolean }

function RequestForm({ request, onRespond }: { request: UiRequest, onRespond: (payload: Payload) => void }) {
    const [value, setValue] = useState(request.prefill ?? '')
    const cancel = () => onRespond({ cancelled: true })
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
        }
    }

    if (request.method === 'select') {
        return (
            <div role="group" aria-label={request.title || '选择'} onKeyDown={onKeyDown} className="flex flex-wrap items-center gap-1.5">
                {(request.options ?? []).map(option => (
                    <button
                        key={option}
                        type="button"
                        onClick={() => onRespond({ value: option })}
                        className="inline-flex min-h-8 max-w-full items-center rounded-[6px] bg-[var(--jb-fill)] px-3 py-1 text-left text-[13px] text-gray-900 outline-none transition-colors hover:bg-[var(--jb-fill-hover)] focus-visible:ring-2 focus-visible:ring-ide-accent/50 [overflow-wrap:anywhere]"
                    >
                        {option}
                    </button>
                ))}
                <Button type="button" variant="ghost" onClick={cancel}>取消</Button>
            </div>
        )
    }

    if (request.method === 'confirm') {
        return (
            <div onKeyDown={onKeyDown} className="flex items-center gap-2">
                <Button variant="primary" className="min-w-[72px]" onClick={() => onRespond({ confirmed: true })}>确认</Button>
                <Button variant="ghost" onClick={() => onRespond({ confirmed: false })}>取消</Button>
            </div>
        )
    }

    const editor = request.method === 'editor'
    return (
        <form
            className="flex flex-col gap-2"
            onKeyDown={(e) => {
                onKeyDown(e)
                // Enter submits a one-line input; the editor needs ⌘ Enter so newlines stay typable.
                if (editor && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    onRespond({ value })
                }
            }}
            onSubmit={(e) => {
                e.preventDefault()
                onRespond({ value })
            }}
        >
            {editor
                ? (
                        <textarea
                            value={value}
                            onChange={e => setValue(e.target.value)}
                            rows={8}
                            aria-label={request.title || '输入'}
                            className={cn(flatFieldClass, 'h-auto w-full max-w-3xl py-2 font-mono leading-5')}
                        />
                    )
                : (
                        <input
                            value={value}
                            placeholder={request.placeholder}
                            onChange={e => setValue(e.target.value)}
                            aria-label={request.title || '输入'}
                            className={cn(flatFieldClass, 'w-full max-w-xl')}
                        />
                    )}
            <div className="flex items-center gap-2">
                <Button type="submit" variant="primary" className="min-w-[72px]">确定</Button>
                <Button type="button" variant="ghost" onClick={cancel}>取消</Button>
                {editor && <span className="ml-auto text-[12px] text-[var(--jb-comment)]">⌘ Enter 提交</span>}
            </div>
        </form>
    )
}

/** The oldest pending extension request of a thread, answered in place. */
export const ExtensionRequest = observer(({ thread }: { thread: Thread }) => {
    const t = useT()
    const request = thread.uiRequests[0]
    if (!request)
        return null
    return (
        <Gutter mark={<span className="text-amber-500">?</span>}>
            <div className="flex min-h-6 items-center gap-1.5 text-[12.5px]">
                <span className="font-medium text-gray-900 [overflow-wrap:anywhere]">{request.title || '扩展请求'}</span>
                <span className="shrink-0 text-amber-600 dark:text-amber-400">{t.askWaiting}</span>
            </div>
            {request.message && <div className="mt-0.5 whitespace-pre-wrap text-[13px] leading-5 text-gray-600">{request.message}</div>}
            <div className="mt-2 mb-1">
                <RequestForm key={request.id} request={request} onRespond={payload => thread.respondUi(request, payload)} />
            </div>
        </Gutter>
    )
})
