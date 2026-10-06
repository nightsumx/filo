import type { Thread, UiRequest } from '@/store/thread'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fieldClass } from '@/components/ui/form'
import { cn } from '@/lib/utils'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'

/** Answers pi's extension UI sub-protocol (select / confirm / input / editor) for one request. */
function RequestDialog({ request, onRespond }: {
    request: UiRequest
    onRespond: (payload: { value?: string, confirmed?: boolean, cancelled?: boolean }) => void
}) {
    const [value, setValue] = useState(request.prefill ?? '')
    const cancel = () => onRespond({ cancelled: true })

    return (
        <Dialog open onOpenChange={open => !open && cancel()}>
            <DialogContent className="max-w-[460px] gap-3 p-5">
                <DialogHeader>
                    <DialogTitle className="pr-6">{request.title || '扩展请求'}</DialogTitle>
                    {request.message && <DialogDescription className="whitespace-pre-wrap">{request.message}</DialogDescription>}
                </DialogHeader>

                {request.method === 'select' && (
                    <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
                        {(request.options ?? []).map((option, i) => (
                            <button
                                key={option}
                                type="button"
                                autoFocus={i === 0}
                                onClick={() => onRespond({ value: option })}
                                className="flex h-7 items-center rounded-[4px] px-2 text-left text-[13px] text-gray-900 outline-none hover:bg-ide-hover focus:bg-ide-sel"
                            >
                                {option}
                            </button>
                        ))}
                    </div>
                )}

                {request.method === 'confirm' && (
                    <DialogFooter>
                        <Button variant="outline" onClick={() => onRespond({ confirmed: false })}>取消</Button>
                        <Button variant="primary" autoFocus onClick={() => onRespond({ confirmed: true })}>确认</Button>
                    </DialogFooter>
                )}

                {(request.method === 'input' || request.method === 'editor') && (
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={(e) => {
                            e.preventDefault()
                            onRespond({ value })
                        }}
                    >
                        {request.method === 'input'
                            ? (
                                    <input
                                        autoFocus
                                        value={value}
                                        placeholder={request.placeholder}
                                        onChange={e => setValue(e.target.value)}
                                        className={cn(fieldClass, 'w-full')}
                                    />
                                )
                            : (
                                    <textarea
                                        autoFocus
                                        value={value}
                                        onChange={e => setValue(e.target.value)}
                                        rows={10}
                                        className={cn(fieldClass, 'h-auto w-full py-1.5 font-mono leading-5')}
                                    />
                                )}
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={cancel}>取消</Button>
                            <Button type="submit" variant="primary">确定</Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    )
}

export const ExtensionDialog = observer(({ thread }: { thread: Thread }) => {
    const request = thread.uiRequests[0]
    if (!request)
        return null
    return <RequestDialog key={request.id} request={request} onRespond={payload => thread.respondUi(request, payload)} />
})
