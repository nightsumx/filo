// browser_* calls: the usual tool row, plus a way to the tab the call was about while it is still open.
import type { BrowserDetails } from '@shared/capabilities'
import type { ToolCall } from '@shared/pi'
import type { ToolResultView } from '@/lib/timeline'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { browserStore } from '@/store/browser'
import { Globe } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { ToolRow } from '../ToolRow'

export const BrowserStep = observer(({ call, result, running, startedAt, ms }: { call: ToolCall, result?: ToolResultView, running: boolean, startedAt?: number, ms?: number }) => {
    const details = result?.details as BrowserDetails | undefined
    const id = details?.kind === 'browser' ? details.tab?.id : undefined
    const open = id ? browserStore.list.find(t => t.id === id) : undefined
    const action = open && (
        <button
            type="button"
            onClick={() => {
                appStore.selectProject(open.cwd)
                browserStore.select(open.id)
            }}
            title={tr('在浏览器面板里查看', 'Show in the Browser panel')}
            className="flex h-[22px] shrink-0 items-center gap-1 rounded px-1.5 font-sans text-[12px] text-gray-500 hover:bg-ide-hover hover:text-gray-800"
        >
            <Globe size={12} aria-hidden />
            {tr('查看页面', 'Show page')}
        </button>
    )
    return <ToolRow call={call} result={result} running={running} startedAt={startedAt} ms={ms} action={action || undefined} />
})
