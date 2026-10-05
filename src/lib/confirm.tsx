import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createRoot } from 'react-dom/client'

interface ConfirmOptions {
    title?: string
    description?: string
    confirmText?: string
    cancelText?: string
}

export function confirm(options: ConfirmOptions | string): Promise<boolean> {
    const {
        title = '确认',
        description = typeof options === 'string' ? options : '',
        confirmText = '确认',
        cancelText = '取消',
    } = typeof options === 'string' ? {} : options

    return new Promise((resolve) => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)

        const cleanup = () => {
            root.unmount()
            document.body.removeChild(container)
        }

        const handleConfirm = () => {
            cleanup()
            resolve(true)
        }

        const handleCancel = () => {
            cleanup()
            resolve(false)
        }

        root.render(
            <Dialog open onOpenChange={handleCancel}>
                <DialogContent className="max-w-[400px]">
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={handleCancel}>{cancelText}</Button>
                        <Button variant="destructive" onClick={handleConfirm}>{confirmText}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>,
        )
    })
}
