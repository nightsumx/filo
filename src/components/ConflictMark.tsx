import { newThreadLabel, tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { TriangleAlert } from 'lucide-react'
import { observer } from 'mobx-react-lite'

/**
 * Amber mark on a thread (tab, project tree) that changed files another session (thread or terminal
 * pi) also changed since the last commit. The tooltip names the files and the other sessions.
 */
export const ConflictMark = observer(({ cwd, session }: { cwd: string, session?: string }) => {
    const conflicts = appStore.conflictsOf(cwd, session)
    if (!conflicts.length)
        return null
    const lines = conflicts.slice(0, 8).map(c => `${c.file} · ${c.others.map(o => `「${o.title || newThreadLabel()}」`).join(tr('、', ', '))}`)
    if (conflicts.length > 8)
        lines.push(tr(`还有 ${conflicts.length - 8} 个文件`, `${conflicts.length - 8} more files`))
    const title = `${tr('和其他线程改了同一批文件：', 'Shares changed files with other threads:')}\n${lines.join('\n')}`
    return (
        <span role="img" aria-label={title} title={title} className="flex shrink-0 items-center text-amber-600 dark:text-amber-400">
            <TriangleAlert size={12} />
        </span>
    )
})
