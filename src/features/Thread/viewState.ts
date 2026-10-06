import { createContext, useCallback, useContext, useState } from 'react'

/**
 * Per-thread UI state (expanded / show-all toggles) that outlives the component. The transcript is
 * virtualized, so a row scrolled out of view unmounts; without this it would come back collapsed.
 */
export const ViewStateContext = createContext<Map<string, unknown> | null>(null)

export function useViewState<T>(id: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
    const store = useContext(ViewStateContext)
    const [value, setValue] = useState<T>(() => (store?.has(id) ? store.get(id) as T : initial))
    const set = useCallback((next: T | ((prev: T) => T)) => {
        setValue((prev) => {
            const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
            store?.set(id, v)
            return v
        })
    }, [store, id])
    return [value, set]
}
