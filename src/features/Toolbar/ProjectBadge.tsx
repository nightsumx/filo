import { cn } from '@/lib/utils'

// JetBrains-style project icon: two initials on a colour picked from the name.
const COLORS = ['#3d72d9', '#c4573c', '#4a9a5e', '#8b62c9', '#bb8a26', '#2f9a9a', '#c45a8c', '#6b7a8f']

function hash(text: string): number {
    let h = 0
    for (const ch of text)
        h = (h * 31 + ch.charCodeAt(0)) | 0
    return Math.abs(h)
}

/** JetBrains rule: "life-sim-codex" → "LC", "myApp" → "MA", single word "fusheng" → "F". */
export function initials(name: string): string {
    const words = name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[\s\-_.]+/)
        .filter(Boolean)
    if (words.length >= 2)
        return (words[0][0] + words[words.length - 1][0]).toUpperCase()
    return (words[0] ?? name).slice(0, 1).toUpperCase()
}

export function ProjectBadge({ name, size = 20, className }: { name: string, size?: number, className?: string }) {
    return (
        <span
            aria-hidden
            className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-[5px] font-semibold leading-none text-always-white', className)}
            style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: COLORS[hash(name) % COLORS.length] }}
        >
            {initials(name)}
        </span>
    )
}
