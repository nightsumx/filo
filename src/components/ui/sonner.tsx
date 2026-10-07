// Copied from chat/src/components/ui/sonner.tsx; next-themes replaced by lib/theme.
import { theme } from '@/lib/theme'
import { observer } from 'mobx-react-lite'
import { Toaster as Sonner } from 'sonner'

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = observer(({ ...props }: ToasterProps) => {
    return (
        <Sonner
            theme={theme.dark ? 'dark' : 'light'}
            className="toaster group"
            toastOptions={{
                classNames: {
                    toast:
                        'group toast group-[.toaster]:bg-elevated group-[.toaster]:border-black/10 group-[.toaster]:backdrop-blur-sm group-[.toaster]:text-gray-700 group-[.toaster]:rounded-md group-[.toaster]:shadow-xl light:group-[.toaster]:shadow-[shadow:var(--ide-float-shadow)]',
                    description: 'group-[.toast]:text-gray-600',
                    actionButton:
                        'group-[.toast]:bg-blue-100 group-[.toast]:text-blue-700 group-[.toast]:rounded-lg',
                    cancelButton:
                        'group-[.toast]:bg-gray-100 group-[.toast]:text-gray-700 group-[.toast]:rounded-lg',
                },
            }}
            {...props}
        />
    )
})

export {
    Toaster,
}
