import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import * as React from 'react'

const buttonVariants = cva(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[4px] text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                default:
                    'bg-black/[0.06] text-gray-900 hover:bg-black/[0.08] active:bg-black/[0.12]',
                primary:
                    'border border-ide-accent bg-ide-accent text-always-white hover:border-ide-accent-hover hover:bg-ide-accent-hover disabled:opacity-40',
                destructive:
                    'bg-[#FF3B30] text-always-white hover:bg-[#FF453A] active:bg-[#FF2D1F]',
                // JetBrains secondary button.
                outline:
                    'border border-[var(--jb-field-border)] bg-[var(--jb-secondary-bg)] text-gray-900 hover:bg-[var(--jb-secondary-hover)] disabled:opacity-100 disabled:border-[var(--jb-disabled-border)] disabled:text-[var(--jb-disabled-fg)]',
                secondary:
                    'bg-black/[0.04] text-gray-900 hover:bg-black/[0.06] active:bg-black/[0.08]',
                ghost: 'text-gray-900 hover:bg-black/[0.04] active:bg-black/[0.06]',
                link: 'text-gray-900 hover:opacity-70 active:opacity-50',
            },
            size: {
                default: 'h-7 px-3.5',
                sm: 'h-7 px-3 text-[12px]',
                lg: 'h-10 rounded-md px-8',
                icon: 'w-8 h-8',
            },
        },
        defaultVariants: {
            variant: 'default',
            size: 'default',
        },
    },
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({
        className,
        variant,
        size,
        asChild = false,
        ...props
    }, ref) => {
        const Comp = asChild ? Slot : 'button'
        return (
            <Comp
                className={cn(buttonVariants({
                    variant,
                    size,
                    className,
                }))}
                ref={ref}
                {...props}
            />
        )
    },
)
Button.displayName = 'Button'

export {
    Button,
    buttonVariants,
}
