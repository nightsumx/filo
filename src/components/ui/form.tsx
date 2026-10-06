// Form controls: check box, radio button, text field, switch, segmented choice, and the flat
// setting row / group used by the Settings dialog.
// Colours come from the --jb-* variables in index.css, so light and dark both follow IntUI.
import { cn } from '@/lib/utils'
import * as React from 'react'

/** Text field: 28px, 4px corners, 1px border that turns into a 2px accent border on focus. */
export const fieldClass = cn(
    'h-7 rounded-[4px] border border-[var(--jb-field-border)] bg-[var(--jb-field-bg)] px-2 text-[13px] text-gray-900 outline-none',
    'placeholder:text-[var(--jb-comment)] focus:border-ide-accent focus:shadow-[0_0_0_1px_var(--ide-accent)]',
    'disabled:border-[var(--jb-disabled-border)] disabled:text-[var(--jb-disabled-fg)]',
)

/** The 14px box of a check box or radio button; put a visually hidden input before it in a label. */
export function CheckMark({ type, checked }: { type: 'checkbox' | 'radio', checked: boolean }) {
    return (
        <span
            aria-hidden
            className={cn(
                'flex h-3.5 w-3.5 shrink-0 items-center justify-center border transition-colors',
                // Focus ring follows the visually hidden input just before this mark.
                'peer-focus-visible:shadow-[0_0_0_2px_var(--jb-dialog-bg),0_0_0_4px_var(--ide-accent)]',
                type === 'checkbox' ? 'rounded-[3px]' : 'rounded-full',
                checked ? 'border-ide-accent bg-ide-accent' : 'border-[var(--jb-check-border)] bg-[var(--jb-check-bg)]',
            )}
        >
            {checked && (type === 'checkbox'
                ? <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 text-always-white"><path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                : <span className="h-1.5 w-1.5 rounded-full bg-always-white" />)}
        </span>
    )
}

interface CheckProps {
    type?: 'checkbox' | 'radio'
    name?: string
    checked: boolean
    onChange: (checked: boolean) => void
    children: React.ReactNode
    /** Grey comment under the label, indented to the label text. */
    comment?: React.ReactNode
    /** Right-aligned extra on the label line. */
    trailing?: React.ReactNode
    className?: string
}

/** Check box or radio button with its label, the way JetBrains settings pages lay them out. */
export function Check({ type = 'checkbox', name, checked, onChange, children, comment, trailing, className }: CheckProps) {
    const commentId = React.useId()
    return (
        <div className={className}>
            <label className="flex min-h-6 cursor-pointer items-center gap-2 text-[13px] text-gray-900">
                <input
                    type={type}
                    name={name}
                    checked={checked}
                    onChange={e => onChange(e.target.checked)}
                    aria-describedby={comment ? commentId : undefined}
                    className="peer sr-only"
                />
                <CheckMark type={type} checked={checked} />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
                {trailing}
            </label>
            {comment && <Comment id={commentId} className="pl-[22px]">{comment}</Comment>}
        </div>
    )
}

/** On/off switch for a setting row; the row's label names it via aria-labelledby. */
export function Switch({ checked, onChange, labelledBy, describedBy }: { checked: boolean, onChange: (checked: boolean) => void, labelledBy?: string, describedBy?: string }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            onClick={() => onChange(!checked)}
            className={cn(
                'relative h-[18px] w-8 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50',
                checked ? 'bg-ide-accent' : 'bg-[var(--jb-switch-off)]',
            )}
        >
            <span className={cn('absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full bg-always-white shadow-sm transition-transform', checked && 'translate-x-[14px]')} />
        </button>
    )
}

/** All choices laid out side by side, so nothing hides behind a menu. Radio-group semantics. */
export function Segmented<T extends string>({ value, options, onChange, labelledBy }: {
    value: T | undefined
    options: { value: T, label: string }[]
    onChange: (value: T) => void
    labelledBy?: string
}) {
    return (
        <div role="radiogroup" aria-labelledby={labelledBy} className="inline-flex shrink-0 rounded-[6px] bg-[var(--jb-fill)] p-0.5">
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={value === o.value}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        'h-6 rounded-[4px] px-3 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ide-accent/50',
                        value === o.value ? 'bg-[var(--jb-dialog-bg)] text-gray-900 shadow-[0_0_0_1px_var(--jb-dialog-border),0_1px_2px_rgba(0,0,0,0.06)]' : 'text-gray-600 hover:text-gray-900',
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    )
}

/** One setting: title and description on the left, its control on the right. */
export function SettingRow({ title, description, control, children }: { title: React.ReactNode, description?: React.ReactNode, control: (ids: { labelId: string, descId?: string }) => React.ReactNode, children?: React.ReactNode }) {
    const labelId = React.useId()
    const descId = React.useId()
    return (
        <div className="py-3">
            <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                    <div id={labelId} className="text-[13px] leading-5 text-gray-900">{title}</div>
                    {description && <Comment id={descId} className="mt-0.5">{description}</Comment>}
                </div>
                {control({ labelId, descId: description ? descId : undefined })}
            </div>
            {children}
        </div>
    )
}

/** A titled group of setting rows separated by hairlines. */
export function SettingGroup({ title, aside, children }: { title: string, aside?: React.ReactNode, children: React.ReactNode }) {
    return (
        <section className="flex flex-col">
            <div className="flex items-baseline gap-2 pb-1">
                <h3 className="text-[12px] font-medium text-[var(--jb-comment)]">{title}</h3>
                {aside && <span className="ml-auto text-[12px] tabular-nums text-[var(--jb-comment)]">{aside}</span>}
            </div>
            <div className="flex flex-col divide-y divide-[var(--jb-separator)]">{children}</div>
        </section>
    )
}

export function Comment({ id, className, children }: { id?: string, className?: string, children: React.ReactNode }) {
    return <div id={id} className={cn('text-[12px] leading-[18px] text-[var(--jb-comment)]', className)}>{children}</div>
}
