import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import React from 'react'
import { twMerge } from 'tailwind-merge'

export const sizeStyle = {
    small: {
        iconSize: 14,
        blockSize: 20,
        borderRadius: 4,
    },
    normal: {
        iconSize: 16,
        blockSize: 28,
        borderRadius: 6,
    },
    medium: {
        iconSize: 18,
        blockSize: 32,
        borderRadius: 7,
    },
    large: {
        iconSize: 20,
        blockSize: 36,
        borderRadius: 8,
    },
}

export interface ActionIconProps {
    color?: string
    loading?: boolean
    active?: boolean
    disable?: boolean
    size?: keyof typeof sizeStyle
    icon?: LucideIcon
    className?: string
    iconClassName?: string
}
export function ActionBtn({
    children,
    className,
    loading,
    active,
    disable,
    size = 'normal',
    icon: Icon,
    iconClassName,
    onClick,
    color,
    title,
    ref,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & ActionIconProps & { ref?: React.Ref<HTMLDivElement> }) {
    const { iconSize, blockSize, borderRadius } = sizeStyle[size]

    const buttonContent = (
        <div
            ref={ref}
            className={twMerge(
                `inline-flex items-center text-center text-icon-color rounded-[${borderRadius}px] cursor-default`,
                'py-1 px-2 gap-1 font-bold select-none',
                disable ? 'opacity-50' : 'hover:text-color-a hover:bg-bg-hover active:text-color-a active:bg-bg-active',
                active && 'text-blue-600 hover:text-blue-600',
                className,
            )}
            style={{
                color,
                borderRadius: `${borderRadius}px`,
                minWidth: `${blockSize}px`,
                minHeight: `${blockSize}px`,
                transition: 'color 600ms cubic-bezier(0.215, 0.61, 0.355, 1),scale 400ms cubic-bezier(0.215, 0.61, 0.355, 1),background-color 100ms cubic-bezier(0.215, 0.61, 0.355, 1)',
            }}
            onMouseDown={e => e.preventDefault()}
            onClick={loading || disable ? undefined : onClick}
            {...props}
            role="button"
            aria-disabled={loading || disable || undefined}
            aria-label={typeof title === 'string' ? title : props['aria-label']}
        >
            {Icon && (
                <span
                    className={twMerge(
                        "active:scale-[0.8] transition-transform duration-[400ms] ease-[cubic-bezier(0.215,0.61,0.355,1)]",
                        iconClassName,
                    )}
                >
                    <Icon size={iconSize} />
                </span>
            )}
            {children}
        </div>
    )

    if (!title) {
        return buttonContent
    }

    return (
        <TooltipProvider delayDuration={0}>
            <Tooltip>
                <TooltipTrigger asChild>
                    {buttonContent}
                </TooltipTrigger>
                <TooltipContent>
                    <p className="whitespace-pre-line">{title}</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    )
}
