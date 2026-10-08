// Trimmed from chat/src/components/ui/context-menu.tsx; styled to match ./dropdown-menu (IDE look).
import { cn } from '@/lib/utils'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import * as React from 'react'

const ContextMenu = ContextMenuPrimitive.Root

const ContextMenuTrigger = ContextMenuPrimitive.Trigger

const ContextMenuContent = React.forwardRef<
    React.ElementRef<typeof ContextMenuPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
    <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
            ref={ref}
            className={cn(
                'z-50 min-w-[8rem] overflow-hidden rounded-lg border border-gray-200 light:border-transparent bg-elevated p-1 text-gray-800 shadow-[0_6px_24px_rgba(0,0,0,0.18)] light:shadow-[shadow:var(--ide-float-shadow)]',
                className,
            )}
            {...props}
        />
    </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
    React.ElementRef<typeof ContextMenuPrimitive.Item>,
    React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
    <ContextMenuPrimitive.Item
        ref={ref}
        className={cn(
            'relative flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] outline-none focus:bg-ide-sel data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&>svg]:shrink-0 [&>svg]:text-gray-500',
            className,
        )}
        {...props}
    />
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuSeparator = React.forwardRef<
    React.ElementRef<typeof ContextMenuPrimitive.Separator>,
    React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
    <ContextMenuPrimitive.Separator ref={ref} className={cn('mx-1 my-1 h-px bg-gray-200', className)} {...props} />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

export {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
}
