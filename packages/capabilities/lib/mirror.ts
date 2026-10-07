// A terminal dialog the desktop app can answer too, when it joined this pi over pi-cc-tui's bridge
// (see DIALOG_EVENTS in ../protocol). Without a bridge nobody listens and only the terminal answers.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { DialogAnswer, DialogRequest } from '../protocol'
import { randomUUID } from 'node:crypto'

const OPEN = 'gui-dialog:open'
const CLOSE = 'gui-dialog:close'
const ANSWER = 'gui-dialog:answer'

/**
 * Runs `local` (the terminal dialog) and offers the same choice to the app; the first answer wins
 * and closes the other side. `signal` (the run's) dismisses both.
 */
export async function mirrored(
    pi: Pick<ExtensionAPI, 'events'>,
    request: Pick<DialogRequest, 'title' | 'options'>,
    local: (signal: AbortSignal) => Promise<string | undefined>,
    signal?: AbortSignal,
): Promise<string | undefined> {
    const id = randomUUID()
    const close = new AbortController()
    let fromAppAnswered = false
    let off = () => {}
    const fromApp = new Promise<string | undefined>((resolve) => {
        off = pi.events.on(ANSWER, (data) => {
            const answer = data as DialogAnswer
            if (answer?.id !== id || close.signal.aborted)
                return
            fromAppAnswered = true
            close.abort()
            resolve(answer.value)
        })
    })
    const onAbort = () => close.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    pi.events.emit(OPEN, { id, method: 'select', ...request } satisfies DialogRequest)
    try {
        const value = await local(close.signal)
        return fromAppAnswered ? await fromApp : value
    }
    finally {
        off()
        signal?.removeEventListener('abort', onAbort)
        pi.events.emit(CLOSE, { id })
    }
}
