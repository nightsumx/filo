import { cn } from '@/lib/utils'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
    React.ElementRef<typeof TooltipPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
    <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
            ref={ref}
            sideOffset={sideOffset}
            className={cn(
                'z-[1000] overflow-hidden rounded-md border border-gray-200 bg-elevated px-2 py-1 text-[12px] text-gray-800 shadow-md',
                className,
            )}
            {...props}
        />
    </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
}
