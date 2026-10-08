// terminal_run / terminal_read / terminal_stop: the usual tool row, plus a way to the terminal it is
// about while that terminal is still open. The button sits at the end of the result line, so the
// row keeps the height the transcript's estimate gives it.
import type { TerminalDetails } from '@shared/capabilities'
import type { ToolCall } from '@shared/pi'
import type { ToolResultView } from '@/lib/timeline'
import { tr } from '@/lib/i18n'
import { terminalStore } from '@/store/terminals'
import { SquareTerminal } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { ToolRow } from '../ToolRow'

export const TerminalStep = observer(({ call, result, running, startedAt, ms }: { call: ToolCall, result?: ToolResultView, running: boolean, startedAt?: number, ms?: number }) => {
    const details = result?.details as TerminalDetails | undefined
    const id = details?.kind === 'terminal' ? details.terminal?.id : undefined
    const open = id ? terminalStore.list.find(t => t.id === id) : undefined
    // Read and stop name a terminal by its id; the call line shows its name instead.
    const named = call.name !== 'terminal_run' && typeof call.arguments?.id === 'string'
    const label = named ? (open?.title ?? details?.terminal?.title) : undefined
    const action = open && (
        <button
            type="button"
            onClick={() => terminalStore.select(open.id)}
            title={tr(`在终端里查看：${open.title}`, `Show in terminal: ${open.title}`)}
            className="flex h-[22px] shrink-0 items-center gap-1 rounded px-1.5 font-sans text-[12px] text-gray-500 hover:bg-ide-hover hover:text-gray-800"
        >
            <SquareTerminal size={12} aria-hidden />
            {tr('查看终端', 'Show terminal')}
        </button>
    )
    return <ToolRow call={call} result={result} running={running} startedAt={startedAt} ms={ms} action={action || undefined} label={label} />
})
