// "Compact at N tokens", the same for every model. pi only knows a reserve (compact once
// tokens > window − reserve), globally or per exact model key, so one point becomes one
// modelOverrides reserve per known model: window − point. Overrides that do not match the point are
// the user's per-model exceptions and are left alone.

/** pi caps the summary at 80% of the reserve; below this a model just follows reserveTokens. */
export const MIN_RESERVE = 8192

export interface ModelWindow {
    key: string
    contextWindow?: number
}

/** The reserve that makes a model compact at `at`, or null when its window is too small for that. */
export function autoReserve(contextWindow: number, at: number): number | null {
    const reserve = contextWindow - at
    return reserve >= MIN_RESERVE ? reserve : null
}

/** Whether a model's override is an exception rather than what the global point gives it. */
export function isCustom(contextWindow: number | undefined, reserve: number | undefined, at: number | null): boolean {
    if (reserve === undefined)
        return false
    if (!contextWindow || at === null)
        return true
    return reserve !== autoReserve(contextWindow, at)
}

/**
 * Writes that move every known, non-exception model from point `from` to point `to` (null: no
 * point, models follow reserveTokens). With from === to it fills in models added since.
 */
export function syncReserves(models: ModelWindow[], reserves: Record<string, number>, from: number | null, to: number | null): Record<string, number | null> {
    const patch: Record<string, number | null> = {}
    for (const { key, contextWindow } of models) {
        if (!contextWindow)
            continue
        const reserve = reserves[key]
        if (isCustom(contextWindow, reserve, from))
            continue
        const next = to === null ? null : autoReserve(contextWindow, to)
        if ((next ?? undefined) !== reserve)
            patch[key] = next
    }
    return patch
}

/**
 * The point most existing overrides share (settings made by hand or by an older version), so
 * they read as the global point rather than as a list of exceptions. Rounded points only.
 */
export function inferCompactAt(models: ModelWindow[], reserves: Record<string, number>): number | null {
    const counts = new Map<number, number>()
    for (const { key, contextWindow } of models) {
        const reserve = reserves[key]
        if (!contextWindow || reserve === undefined || contextWindow - reserve <= 0)
            continue
        const at = contextWindow - reserve
        counts.set(at, (counts.get(at) ?? 0) + 1)
    }
    let best: [number, number] | undefined
    for (const entry of counts) {
        if (!best || entry[1] > best[1])
            best = entry
    }
    return best && best[1] >= 2 && best[0] % 1000 === 0 ? best[0] : null
}
