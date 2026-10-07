// Flat form controls: answer chips, filled text field, switch, segmented choice, and the setting
// row / group used by the Settings dialog. Colours come from the --jb-* variables in index.css.
import { cn } from '@/lib/utils'
import { observer } from 'mobx-react-lite'
import * as React from 'react'

/**
 * One answer laid out as a chip, so every choice is visible at once. Radio or check-box semantics
 * come from the visually hidden input, which keeps arrow-key navigation inside a radio group.
 */
export function Choice({ type, name, checked, onChange, children }: { type: 'checkbox' | 'radio', name?: string, checked: boolean, onChange: () => void, children: React.ReactNode }) {
    return (
        <label
            className={cn(
                'inline-flex min-h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-[6px] px-3 py-1 text-[13px] transition-colors',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ide-accent/50',
                checked ? 'bg-ide-accent/[0.14] text-ide-accent dark:text-[#8fb3ff]' : 'bg-[var(--jb-fill)] text-gray-800 hover:bg-[var(--jb-fill-hover)]',
            )}
        >
            <input type={type} name={name} checked={checked} onChange={onChange} className="sr-only" />
            {/* Multi-select marks the picked chips; single choice needs no mark beyond the fill. */}
            {type === 'checkbox' && checked && <svg aria-hidden viewBox="0 0 10 10" className="-ml-0.5 h-3 w-3"><path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        </label>
    )
}

/** Borderless filled text field, for inline forms that should read as part of the transcript. */
export const flatFieldClass = cn(
    'h-8 rounded-[6px] bg-[var(--jb-fill)] px-3 text-[13px] text-gray-900 outline-none transition-shadow',
    'placeholder:text-[var(--jb-comment)] focus:shadow-[0_0_0_1.5px_var(--ide-accent)]',
)

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

/**
 * One setting: title and description on the left, its control on the right. An observer because
 * `control` runs in this render: store values read only inside it would otherwise not re-render.
 */
export const SettingRow = observer(({ title, description, control, children }: { title: React.ReactNode, description?: React.ReactNode, control: (ids: { labelId: string, descId?: string }) => React.ReactNode, children?: React.ReactNode }) => {
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
})

/** One settings page: its title (with an optional note on the right) over hairline-separated rows. */
export function SettingsPage({ title, aside, children }: { title: string, aside?: React.ReactNode, children: React.ReactNode }) {
    return (
        <section className="flex flex-col" aria-label={title}>
            <div className="flex h-12 shrink-0 items-center gap-2 pr-7">
                <h2 className="text-[14px] font-semibold text-gray-900">{title}</h2>
                {aside && <span className="ml-auto text-[12px] tabular-nums text-[var(--jb-comment)]">{aside}</span>}
            </div>
            <div className="flex flex-col divide-y divide-[var(--jb-separator)]">{children}</div>
        </section>
    )
}

export function Comment({ id, className, children }: { id?: string, className?: string, children: React.ReactNode }) {
    return <div id={id} className={cn('text-[12px] leading-[18px] text-[var(--jb-comment)]', className)}>{children}</div>
}
