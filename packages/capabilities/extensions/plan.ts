// plan: read-only exploration that ends in a plan the user approves before anything changes.
//   /gui-plan on|off                          the GUI's mode picker
//   propose_plan (tool, plan mode only)       publishes the plan as pending details and waits
//   /gui-plan-decide <toolCallId> <json>      approve (plan mode ends, the run carries on with all
//                                             tools), ask for changes, or dismiss
//   pi.events gui-plan:set <boolean>          switch from another extension (pi-cc-tui's mode key)
// While on, the active tools are cut to read-only ones (built-in readers, tools annotated
// readOnlyHint) plus bash limited to read-only commands. State follows the branch through a custom
// entry; status `gui-plan` is `on` while it is on, and event `gui-plan:mode` carries it. In the
// terminal the plan shows in the transcript and the decision is Claude Code's "Ready to code?" box.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ApprovalMode, GuiCommands, PlanDecision, PlanDetails } from '../protocol'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { isReadOnlyCommand } from '../lib/readonly'
import { choose, serialized } from '../tui/dialog'
import { hang, header } from '../tui/render'

const COMMAND: GuiCommands['plan'] = 'gui-plan'
const DECIDE_COMMAND: GuiCommands['planDecide'] = 'gui-plan-decide'
const STATUS = 'gui-plan'
const ENTRY = 'gui-plan'
const TOOL = 'propose_plan'
const SET_EVENT = 'gui-plan:set'
const MODE_EVENT = 'gui-plan:mode'
const APPROVAL_SET_EVENT = 'gui-approval:set'

const READ_ONLY_BUILTINS = new Set(['read', 'grep', 'find', 'ls'])

const INSTRUCTIONS = `Plan mode is on: explore read-only and design the change before making it.
- Only read-only tools are available, and bash runs only read-only commands (ls, cat, rg, git status/log/diff, ...). Anything else is blocked.
- Investigate until you can be specific: the files and functions to change, in order, and how you will verify the result.
- When the plan is ready, call ${TOOL} with the whole plan in Markdown instead of replying with it. The user approves it or asks for changes.
- Plan mode lasts until ${TOOL} reports that the user approved. From then on all tools are back: implement the plan.`

interface State {
    enabled: boolean
    /** Active tools before plan mode, restored when it ends. */
    before?: string[]
}

export default function (pi: ExtensionAPI) {
    const state: State = { enabled: false }
    const waiting = new Map<string, (decision: PlanDecision) => void>()

    let current: ExtensionContext | undefined

    const publish = (ctx: ExtensionContext) => {
        ctx.ui.setStatus(STATUS, state.enabled ? 'on' : undefined)
        pi.events.emit(MODE_EVENT, state.enabled)
    }
    const persist = () => pi.appendEntry<State>(ENTRY, { enabled: state.enabled, before: state.before })

    function readOnlyTools(names: string[]): string[] {
        const all = new Map(pi.getAllTools().map(t => [t.name, t]))
        const kept = names.filter(n => n !== TOOL && (READ_ONLY_BUILTINS.has(n) || n === 'bash' || all.get(n)?.annotations?.readOnlyHint === true))
        return [...kept, TOOL]
    }

    function apply() {
        if (state.enabled)
            pi.setActiveTools(readOnlyTools(state.before ?? pi.getActiveTools()))
        else
            pi.setActiveTools((state.before ?? pi.getActiveTools()).filter(n => n !== TOOL))
    }

    function set(on: boolean, ctx: ExtensionContext) {
        if (on === state.enabled)
            return publish(ctx)
        if (on)
            state.before = pi.getActiveTools().filter(n => n !== TOOL)
        state.enabled = on
        apply()
        if (!on)
            state.before = undefined
        persist()
        publish(ctx)
    }

    pi.registerTool({
        name: TOOL,
        label: 'Plan',
        description: 'Present the finished plan to the user for approval. Only available in plan mode.',
        promptSnippet: 'Present a finished plan for the user to approve',
        parameters: Type.Object({
            plan: Type.String({ description: 'The complete plan in Markdown: steps in order, files to change, how to verify.' }),
        }),
        annotations: { readOnlyHint: true },
        executionMode: 'sequential',

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const plan = params.plan.trim()
            const pending: PlanDetails = { kind: 'plan', status: 'pending', plan }
            onUpdate?.({ content: [{ type: 'text', text: 'Waiting for the user to review the plan.' }], details: pending })

            const decision = ctx.mode === 'tui'
                ? await serialized(() => decideInTerminal(ctx, plan))
                : await new Promise<PlanDecision>((resolve) => {
                    const finish = (d: PlanDecision) => {
                        waiting.delete(toolCallId)
                        signal?.removeEventListener('abort', onAbort)
                        resolve(d)
                    }
                    const onAbort = () => finish({ cancelled: true })
                    if (signal?.aborted)
                        return finish({ cancelled: true })
                    signal?.addEventListener('abort', onAbort, { once: true })
                    waiting.set(toolCallId, finish)
                })

            if ('approve' in decision) {
                set(false, ctx)
                const details: PlanDetails = { kind: 'plan', status: 'approved', plan }
                return { content: [{ type: 'text', text: 'The user approved the plan. Plan mode is off and all tools are available again. Implement the plan now.' }], details }
            }
            if ('feedback' in decision) {
                const details: PlanDetails = { kind: 'plan', status: 'revised', plan, feedback: decision.feedback }
                return { content: [{ type: 'text', text: `The user wants changes before approving:\n\n${decision.feedback}\n\nStay in plan mode, revise the plan, and call ${TOOL} again.` }], details }
            }
            const details: PlanDetails = { kind: 'plan', status: 'cancelled', plan }
            return { content: [{ type: 'text', text: 'The user dismissed the plan without approving it. Stop and wait for their next message.' }], details, terminate: true }
        },

        renderShell: 'self',
        // The plan itself is read in the "Ready to code?" box; the transcript keeps the approved one.
        renderCall(_args, theme, context) {
            return header(theme, context, 'Plan')
        },
        renderResult(result, _options, theme) {
            const details = result.details as PlanDetails | undefined
            switch (details?.status) {
                case 'approved': {
                    const box = new Container()
                    box.addChild(hang(theme, [theme.fg('success', 'User approved pi\'s plan:')]))
                    box.addChild(new Markdown(details.plan, 5, 0, getMarkdownTheme()))
                    return box
                }
                case 'revised':
                    return hang(theme, [`User asked for changes: ${details.feedback}`])
                case 'cancelled':
                    return hang(theme, [theme.fg('dim', 'Plan dismissed')])
                default:
                    return new Text('', 0, 0)
            }
        },
    })

    /** Claude Code's choices; approving also picks how edits are approved from here on. */
    async function decideInTerminal(ctx: ExtensionContext, plan: string): Promise<PlanDecision> {
        const options = ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning']
        const index = await choose(ctx, { title: 'Ready to code?', body: ['Here is pi\'s plan:'], markdown: plan, question: 'Would you like to proceed?', options })
        if (index === 0 || index === 1) {
            pi.events.emit(APPROVAL_SET_EVENT, (index === 0 ? 'edits' : 'ask') satisfies ApprovalMode)
            return { approve: true }
        }
        if (index === undefined)
            return { cancelled: true }
        const feedback = (await ctx.ui.input('What should change in the plan?', 'Tell pi what to do differently'))?.trim()
        return feedback ? { feedback } : { cancelled: true }
    }

    pi.events.on(SET_EVENT, (on) => {
        if (typeof on === 'boolean' && current)
            set(on, current)
    })

    pi.on('session_start', async (_event, ctx) => {
        current = ctx
        const saved = ctx.sessionManager.getBranch()
            .filter((e: any) => e.type === 'custom' && e.customType === ENTRY)
            .pop() as { data?: State } | undefined
        state.enabled = saved?.data?.enabled === true
        state.before = state.enabled && Array.isArray(saved?.data?.before) ? saved.data.before : undefined
        apply()
        publish(ctx)
    })

    pi.on('before_agent_start', async (event) => {
        if (state.enabled)
            event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, plan_mode: INSTRUCTIONS }
    })

    pi.on('tool_call', async (event) => {
        if (!state.enabled || event.toolName !== 'bash')
            return undefined
        const command = String((event.input as any).command ?? '')
        if (isReadOnlyCommand(command))
            return undefined
        return { block: true, reason: `Plan mode allows only read-only commands; this one was blocked: ${command}` }
    })

    pi.registerCommand(COMMAND, {
        description: 'Internal: turn plan mode on or off',
        handler: async (args, ctx) => {
            const value = args.trim()
            if (value !== 'on' && value !== 'off')
                return ctx.ui.notify(`用法：/${COMMAND} on|off`, 'error')
            set(value === 'on', ctx)
        },
    })

    pi.registerCommand(DECIDE_COMMAND, {
        description: 'Internal: approve or revise a proposed plan',
        handler: async (args, ctx) => {
            const space = args.indexOf(' ')
            const id = space < 0 ? args.trim() : args.slice(0, space)
            const finish = waiting.get(id)
            if (!finish)
                return ctx.ui.notify('这个计划已经结束了', 'warning')
            let decision: PlanDecision
            try {
                decision = JSON.parse(args.slice(space + 1))
            }
            catch {
                return ctx.ui.notify('回复格式无效', 'error')
            }
            if ('feedback' in decision && typeof decision.feedback === 'string' && decision.feedback.trim())
                finish({ feedback: decision.feedback.trim() })
            else
                finish('approve' in decision ? { approve: true } : { cancelled: true })
        },
    })
}
