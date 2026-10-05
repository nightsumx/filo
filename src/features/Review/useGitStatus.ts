import type { GitStatus } from '@shared/ipc'
import { useCallback, useEffect, useState } from 'react'

/** git status for a folder, refetched whenever `tick` changes (tool writes, run end, manual refresh). */
export function useGitStatus(cwd: string | undefined, tick: number) {
    const [status, setStatus] = useState<GitStatus | null>(null)
    const [loading, setLoading] = useState(false)
    const [manual, setManual] = useState(0)

    useEffect(() => {
        if (!cwd)
            return
        let cancelled = false
        setLoading(true)
        window.pi.gitStatus(cwd)
            .then(s => !cancelled && setStatus(s))
            .catch(() => !cancelled && setStatus({ isRepo: false }))
            .finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
        }
    }, [cwd, tick, manual])

    const refresh = useCallback(() => setManual(n => n + 1), [])
    const totals = status?.isRepo
        ? status.files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 })
        : { add: 0, del: 0 }
    return { status, loading, refresh, totals }
}
