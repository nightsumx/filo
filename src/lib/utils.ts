// cn / formatCost / formatTokens copied from chat/src/lib/utils/index.ts; the rest is pi-gui specific.
import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

export function formatCost(cost: number | undefined | null): string {
    if (cost == null || !Number.isFinite(cost))
        return '$0.000'
    return `$${cost.toFixed(3)}`
}

export function formatTokens(tokens: number | undefined | null): string {
    if (tokens == null || !Number.isFinite(tokens))
        return '0'
    if (tokens < 1000000)
        return `${(tokens / 1000).toFixed(1)}K`
    return `${(tokens / 1000000).toFixed(1)}M`
}

export function basename(p: string): string {
    const parts = p.split('/').filter(Boolean)
    return parts[parts.length - 1] || p
}

/** "/Users/me/code/app" → "~/code/app" for display. */
export function tildify(p: string, home?: string): string {
    return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

export function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60)
        return `${s} 秒`
    const m = Math.floor(s / 60)
    if (m < 60)
        return `${m} 分 ${s % 60} 秒`
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

export function relativeTime(ts: number, now = Date.now()): string {
    const s = Math.max(0, Math.floor((now - ts) / 1000))
    if (s < 60)
        return '刚刚'
    if (s < 3600)
        return `${Math.floor(s / 60)} 分钟`
    if (s < 86400)
        return `${Math.floor(s / 3600)} 小时`
    if (s < 86400 * 30)
        return `${Math.floor(s / 86400)} 天`
    return new Date(ts).toLocaleDateString()
}

export function uid(): string {
    return crypto.randomUUID()
}

/**
 * Provider errors often arrive as the raw response body, e.g.
 * `{"type":"error","error":{"type":"internal_error","message":"服务器连接出错，请重试"}}`, sometimes behind
 * a prefix such as `529 `. Show just the message; anything that is not such JSON is returned unchanged.
 */
export function readableError(text: string): string {
    const start = text.indexOf('{')
    if (start < 0)
        return text
    try {
        const body = JSON.parse(text.slice(start))
        const message = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : undefined)
        if (typeof message !== 'string' || !message.trim())
            return text
        const prefix = text.slice(0, start).trim().replace(/[:：]$/, '').trim()
        return prefix ? `${prefix}：${message.trim()}` : message.trim()
    }
    catch {
        return text
    }
}

/** "/Users/me/code/app" → "~/code/app" without needing the home dir from the main process. */
export function shortPath(p: string): string {
    return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}
