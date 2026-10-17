import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { tr } from './i18n'

interface ConfirmOptions {
    title?: string
    description?: string
    confirmText?: string
    cancelText?: string
    /** A checkbox under the text; `confirmWithToggle` returns what it was set to. */
    toggle?: { label: string, checked?: boolean }
}

function ask(options: ConfirmOptions | string): Promise<{ confirmed: boolean, checked: boolean }> {
    const {
        title = tr('确认', 'Confirm'),
        description = typeof options === 'string' ? options : '',
        confirmText = tr('确认', 'Confirm'),
        cancelText = tr('取消', 'Cancel'),
        toggle,
    } = typeof options === 'string' ? {} : options

    return new Promise((resolve) => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)

        const cleanup = () => {
            root.unmount()
            document.body.removeChild(container)
        }

        const Body = () => {
            const [checked, setChecked] = useState(!!toggle?.checked)
            const done = (confirmed: boolean) => {
                cleanup()
                resolve({ confirmed, checked })
            }
            return (
                <Dialog open onOpenChange={() => done(false)}>
                    <DialogContent className="max-w-[400px]">
                        <DialogHeader>
                            <DialogTitle>{title}</DialogTitle>
                            <DialogDescription>{description}</DialogDescription>
                        </DialogHeader>
                        {toggle && (
                            <label className="flex items-center gap-2 text-[13px] text-gray-800 select-none">
                                <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="size-3.5 accent-[var(--ide-accent,currentColor)]" />
                                {toggle.label}
                            </label>
                        )}
                        <DialogFooter>
                            <Button variant="outline" onClick={() => done(false)}>{cancelText}</Button>
                            <Button variant="destructive" onClick={() => done(true)}>{confirmText}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )
        }
        root.render(<Body />)
    })
}

export async function confirm(options: ConfirmOptions | string): Promise<boolean> {
    return (await ask(options)).confirmed
}

/** `confirm` with a checkbox (`options.toggle`): the answer, and whether the box was ticked. */
export function confirmWithToggle(options: ConfirmOptions): Promise<{ confirmed: boolean, checked: boolean }> {
    return ask(options)
}
