import type { Thread } from '@/store/thread'
import { createContext, useContext } from 'react'

/** The thread a transcript belongs to, for steps that act on it (answering ask, …). */
export const ThreadContext = createContext<Thread | null>(null)

export function useThread(): Thread | null {
    return useContext(ThreadContext)
}
