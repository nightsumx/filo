// Above the composer once the prompt cache has likely expired: the next message reads the whole
// context again at the uncached price. Dismissed until the cache is used again.
import type { Thread } from '@/store/thread'
import type { AssistantMessage } from '@shared/pi'
import { cacheStats } from 'pi-capabilities/lib/promptCache.ts'
import { contextTokens, uncachedCost } from '@/lib/cacheCost'
import { formatCost, formatTokens, timeAgo } from '@/lib/utils'
import { TimerOff, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { tr } from '@/lib/i18n'

function lastReply(thread: Thread): AssistantMessage | undefined {
    for (const list of [thread.live, thread.items]) {
        for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i].message
            if (m.role === 'assistant')
                return m
        }
    }
    return undefined
}

export const CacheNotice = observer(({ thread }: { thread: Thread }) => {
    const [tick, setTick] = useState(0)
    const [dismissed, setDismissed] = useState(0)
    const reply = lastReply(thread)
    const usedAt = cacheStats([...thread.items, ...thread.live].map(i => i.message), thread.cacheTtl).usedAt
    const expiresAt = usedAt + thread.cacheTtl
    const now = Date.now()
    // Renders again at expiry, then once a minute for the "N min ago" figure.
    useEffect(() => {
        if (!usedAt || thread.running)
            return
        const left = expiresAt - Date.now()
        const timer = setTimeout(() => setTick(t => t + 1), left > 0 ? left : 60_000)
        return () => clearTimeout(timer)
    }, [usedAt, thread.running, expiresAt, tick])

    if (!usedAt || thread.running || now < expiresAt || dismissed === usedAt)
        return null
    const ago = timeAgo(usedAt, now)
    const tokens = contextTokens(thread.stats?.contextUsage?.tokens, reply)
    const cost = tokens ? uncachedCost(tokens, thread.state?.model, reply) : null
    const price = cost ? formatCost(cost) : ''
    return (
        <div role="status" className="mb-2 flex items-center gap-3 rounded-md bg-ide-block px-3 py-2 text-[12.5px] text-gray-700">
            <TimerOff size={14} className="shrink-0 text-[var(--sl-warn)]" />
            <span className="min-w-0 flex-1">
                {tokens
                    ? tr(
                        `提示缓存已过期（上次使用在 ${ago}）。下一条消息会按未缓存价格重新读入 ${formatTokens(tokens)} 上下文${price ? `，预计约 ${price}` : ''}。`,
                        `The prompt cache has expired (last used ${ago}). The next message reads the ${formatTokens(tokens)} context again at the uncached price${price ? `, about ${price}` : ''}.`,
                    )
                    : tr(`提示缓存已过期（上次使用在 ${ago}）。下一条消息会按未缓存价格重新读入上下文。`, `The prompt cache has expired (last used ${ago}). The next message reads the context again at the uncached price.`)}
            </span>
            <button
                type="button"
                aria-label={tr('关闭提示', 'Dismiss')}
                onClick={() => setDismissed(usedAt)}
                className="shrink-0 rounded p-0.5 text-gray-400 outline-none hover:bg-black/[0.06] hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-ide-accent/50"
            >
                <X size={13} />
            </button>
        </div>
    )
})
