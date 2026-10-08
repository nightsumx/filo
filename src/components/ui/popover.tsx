import { useIsInsideDialog } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import * as PopoverPrimitive from '@radix-ui/react-popover'

import * as React from 'react'

// 嵌套在 Dialog 内时自动 modal=true，让 Popover 自己挂一层 RemoveScroll，
// 接管外层 Dialog 的滚动锁，否则内部 wheel/touch 会被外层吃掉。
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
    const insideDialog = useIsInsideDialog()
    return <PopoverPrimitive.Root modal={insideDialog} {...props} />
}

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
    React.ElementRef<typeof PopoverPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
    <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
            ref={ref}
            align={align}
            sideOffset={sideOffset}
            className={cn(
                'z-[1000] w-72 rounded-lg border border-gray-200 light:border-transparent bg-elevated p-4 text-gray-800 shadow-[0_6px_24px_rgba(0,0,0,0.18)] light:shadow-[shadow:var(--ide-float-shadow)] outline-none',
                className,
            )}
            {...props}
        />
    </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
