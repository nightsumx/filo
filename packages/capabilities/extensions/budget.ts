// budget: a prompt that has cost more than the limit stops before its next request and asks whether
// to go on. The limit is `budget` under pi-capabilities in settings.json (US dollars, read at every
// check, so a change applies at once). A prompt counts from a message the user sends until the next
// one: autopilot's replies in the user's place and subagents' results add to it. Each pi process
// counts its own, so a subagent asks about itself, in the parent session (lib/child.ts forwards it).
// Prices are pi's: a model without one costs nothing here.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import process from 'node:process'
import { mirrored } from '../lib/mirror'
import { readCapabilityState } from '../lib/settings'
import { ENV } from '../protocol'

export default function (pi: ExtensionAPI) {
    let spent = 0
    /** What had been spent when the user last chose to go on; the next question comes a limit later. */
    let allowed = 0
    let quiet = false

    pi.on('input', (event) => {
        if (event.source === 'extension' || event.text.startsWith('/'))
            return
        spent = 0
        allowed = 0
        quiet = false
    })

    pi.on('message_end', (event) => {
        spent += (event.message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total ?? 0
    })

    pi.on('turn_end', async (event, ctx) => {
        const limit = readCapabilityState(getAgentDir()).budget
        if (quiet || spent < allowed + limit || event.message.role !== 'assistant' || event.message.stopReason !== 'toolUse')
            return
        const go = `继续（再花 $${limit} 时再问）`
        const always = '这次不再问'
        const stop = '停止'
        const title = `${process.env[ENV.subagent] ? '这个子 Agent' : '这次提问'}已经花了 $${spent.toFixed(2)}，超过了上限 $${limit}。继续吗？`
        const options = [go, always, stop]
        const choice = ctx.mode === 'tui'
            ? await mirrored(pi, { title, options }, signal => ctx.ui.select(title, options, { signal }), ctx.signal)
            : await ctx.ui.select(title, options, { signal: ctx.signal })
        if (choice === go) {
            allowed = spent
            return
        }
        if (choice === always) {
            quiet = true
            return
        }
        ctx.ui.notify(`已按花费上限停下（$${spent.toFixed(2)}）`, 'warning')
        ctx.abort()
    })
}
