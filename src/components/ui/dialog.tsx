import { cn } from '@/lib/utils'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import * as React from 'react'

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

// 标记当前子树位于 Dialog 内：嵌套的 Popover/Dropdown/ContextMenu 检测到后会自动 modal={true}，
// 让自己的 RemoveScroll 接管，从而允许内部滚动（默认 modal=false 时被外层 Dialog 的 scroll 锁拦截）。
const InsideDialogContext = React.createContext(false)
export const useIsInsideDialog = () => React.useContext(InsideDialogContext)

const DialogOverlay = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
            // JetBrains dialogs do not blur or darken the IDE behind them; a faint scrim only marks modality.
            'fixed inset-0 z-50 bg-[var(--jb-scrim)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            className,
        )}
        {...props}
    />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { fullscreen?: boolean, hideClose?: boolean }
>(({ className, children, fullscreen, hideClose, ...props }, ref) => (
    <DialogPortal>
        <DialogOverlay />
        {/*
          居中用 flex，不用 content 上的 translate/zoom。
          Google GIS 登录 iframe 在任意 transform 祖先下会变成 0×0，看起来有按钮但点不中。
        */}
        {fullscreen
            ? (
                    <DialogPrimitive.Content
                        ref={ref}
                        className={cn(
                            'fixed inset-0 z-50 flex flex-col bg-white duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom-4 data-[state=open]:slide-in-from-bottom-4 select-text',
                            className,
                        )}
                        {...props}
                    >
                        <InsideDialogContext.Provider value={true}>
                            {children}
                        </InsideDialogContext.Provider>
                        <DialogPrimitive.Close className="absolute right-3 top-3 rounded-lg p-1 bg-gray-100 text-gray-600 transition-all hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-200 disabled:pointer-events-none">
                            <X className="h-4 w-4" />
                            <span className="sr-only">Close</span>
                        </DialogPrimitive.Close>
                    </DialogPrimitive.Content>
                )
            : (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                        <DialogPrimitive.Content
                            ref={ref}
                            className={cn(
                                // 不要 animate zoom/slide（会写 transform）；GSI 登录在 transform 祖先下 iframe=0×0
                                // macOS window look: 10px corners, hairline border, soft shadow.
                                'pointer-events-auto relative flex flex-col w-full max-w-[1200px] gap-4 rounded-[10px] border border-[var(--jb-dialog-border)] bg-[var(--jb-dialog-bg)] p-6 shadow-[var(--jb-dialog-shadow)] outline-none select-text',
                                className,
                            )}
                            {...props}
                        >
                            <InsideDialogContext.Provider value={true}>
                                {children}
                            </InsideDialogContext.Provider>
                            {!hideClose && (
                                <DialogPrimitive.Close className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-[4px] text-gray-500 hover:bg-ide-hover hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50">
                                    <X className="h-4 w-4" />
                                    <span className="sr-only">关闭</span>
                                </DialogPrimitive.Close>
                            )}
                        </DialogPrimitive.Content>
                    </div>
                )}
    </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

function DialogHeader({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                'flex flex-col gap-1 text-left',
                className,
            )}
            {...props}
        />
    )
}
DialogHeader.displayName = 'DialogHeader'

function DialogFooter({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                'flex flex-row justify-end gap-2',
                className,
            )}
            {...props}
        />
    )
}
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn(
            'text-[13px] font-semibold leading-5 text-gray-900',
            className,
        )}
        {...props}
    />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Description>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn('text-[13px] leading-5 text-gray-700', className)}
        {...props}
    />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger,
}
