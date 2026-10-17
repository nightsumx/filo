// Session info (pi's /session, for every agent): where the session lives and what it has used.
import type { Thread } from '@/store/thread'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { tr } from '@/lib/i18n'
import { sessionInfoRows } from '@/lib/sessionInfo'
import { showInFolderLabel } from '@/platform'
import { observable, runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'

/** The thread whose info is open; the menu item sets it, the dialog (mounted once in App) reads it. */
const shown = observable({ thread: null as Thread | null })

export function showSessionInfo(thread: Thread) {
    runInAction(() => (shown.thread = thread))
    // The numbers were last read when the last turn ended.
    void Promise.all([thread.syncState(), thread.refreshStats()])
}

export const SessionInfoDialog = observer(() => {
    const thread = shown.thread
    const rows = thread ? sessionInfoRows(thread.agent, thread.state, thread.stats) : []
    return (
        <Dialog open={!!thread} onOpenChange={open => !open && runInAction(() => (shown.thread = null))}>
            <DialogContent className="max-w-[560px]">
                <DialogTitle>{tr('会话信息', 'Session info')}</DialogTitle>
                <DialogDescription className="truncate">{thread?.title}</DialogDescription>
                {rows.length === 0 && <p className="text-[13px] text-gray-500">{tr('这个 agent 还没有报告会话信息。', 'This agent has not reported any session details yet.')}</p>}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                    {rows.map(row => (
                        <div key={row.id} className="contents" data-row={row.id}>
                            <dt className="text-gray-500">{row.label}</dt>
                            <dd className="min-w-0 select-text text-gray-900 [overflow-wrap:anywhere]">
                                {row.value}
                                {row.file && (
                                    <Button variant="outline" size="sm" className="ml-2 align-middle" onClick={() => void window.pi.revealPath(row.file!)}>
                                        {showInFolderLabel()}
                                    </Button>
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
            </DialogContent>
        </Dialog>
    )
})
