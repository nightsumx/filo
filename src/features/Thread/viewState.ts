import { createContext, useCallback, useContext, useState } from 'react'

/**
 * Per-thread UI state (expanded / show-all toggles) that outlives the component. The transcript is
 * virtualized, so a row scrolled out of view unmounts; without this it would come back collapsed.
 */
export const ViewStateContext = createContext<Map<string, unknown> | null>(null)

/**
 * Stops the transcript following the bottom. Every toggle calls it: expanding a row near the
 * bottom would otherwise keep the bottom fixed and push the clicked row up instead of opening down.
 */
export const UnpinContext = createContext<() => void>(() => {})

export function useViewState<T>(id: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
    const store = useContext(ViewStateContext)
    const unpin = useContext(UnpinContext)
    const [value, setValue] = useState<T>(() => (store?.has(id) ? store.get(id) as T : initial))
    const set = useCallback((next: T | ((prev: T) => T)) => {
        unpin()
        setValue((prev) => {
            const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
            store?.set(id, v)
            return v
        })
    }, [store, id, unpin])
    return [value, set]
}
