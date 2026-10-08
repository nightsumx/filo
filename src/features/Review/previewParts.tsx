import { formatBytes } from '@/lib/filePreview'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** Muted one-line notice inside an open row (loading, too large, nothing to show). */
export const note = 'px-1 py-2 text-[12px] text-gray-400'

/** "Before" / "After" when both versions are shown, nothing when there is only one. */
export function sideLabel(key: 'old' | 'new', both: boolean): string {
    if (!both)
        return ''
    return key === 'old' ? tr('之前', 'Before') : tr('之后', 'After')
}

/** Small pill switch, as the panel's All / This thread scope. */
export function Segmented<T extends string | number>({ options, value, onChange, label }: {
    options: { value: T, label: string }[]
    value: T
    onChange: (value: T) => void
    label: string
}) {
    return (
        <div className="flex gap-0.5" role="group" aria-label={label}>
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    aria-pressed={value === o.value}
                    onClick={() => onChange(o.value)}
                    className={cn('flex h-[22px] items-center rounded-md px-2 text-[12px]', value === o.value ? 'bg-black/[0.07] text-gray-900' : 'text-gray-500 hover:text-gray-800')}
                >
                    {o.label}
                </button>
            ))}
        </div>
    )
}

/** Before / After switch for previews too wide to show twice; renders nothing for a single version. */
export function VersionSwitch({ labels, value, onChange }: { labels: string[], value: number, onChange: (i: number) => void }) {
    if (labels.length < 2)
        return null
    return (
        <div className="mb-1.5">
            <Segmented options={labels.map((label, i) => ({ value: i, label }))} value={value} onChange={onChange} label={tr('版本', 'Version')} />
        </div>
    )
}

/** Label, details and size above one version. */
export function Caption({ label, detail, size }: { label?: string, detail?: string, size?: number }) {
    const text = [detail, size !== undefined ? formatBytes(size) : ''].filter(Boolean).join(' · ')
    if (!label && !text)
        return null
    return (
        <div className="flex min-w-0 items-baseline gap-1.5 px-0.5 pb-1 text-[12px] tabular-nums">
            {label && <span className="shrink-0 font-medium text-gray-700">{label}</span>}
            <span className="truncate text-gray-500">{text}</span>
        </div>
    )
}
