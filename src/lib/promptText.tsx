// Text-input sibling of confirm.tsx (same imperative createRoot pattern, copied from chat).
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

function PromptDialog({ title, initial, placeholder, onDone }: {
    title: string
    initial: string
    placeholder?: string
    onDone: (value: string | null) => void
}) {
    const [value, setValue] = useState(initial)
    return (
        <Dialog open onOpenChange={() => onDone(null)}>
            <DialogContent className="max-w-[420px] p-6">
                <DialogHeader>
                    <DialogTitle className="text-base">{title}</DialogTitle>
                </DialogHeader>
                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        onDone(value)
                    }}
                    className="flex flex-col gap-4"
                >
                    <input
                        autoFocus
                        value={value}
                        placeholder={placeholder}
                        onChange={e => setValue(e.target.value)}
                        className="h-10 w-full rounded-md bg-black/[0.06] px-3 text-sm outline-none focus:outline focus:outline-2 focus:outline-blue-400/50"
                    />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onDone(null)}>取消</Button>
                        <Button type="submit" variant="primary">确定</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

export function promptText(options: { title: string, initial?: string, placeholder?: string }): Promise<string | null> {
    return new Promise((resolve) => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const done = (value: string | null) => {
            root.unmount()
            container.remove()
            resolve(value)
        }
        root.render(<PromptDialog title={options.title} initial={options.initial ?? ''} placeholder={options.placeholder} onDone={done} />)
    })
}
