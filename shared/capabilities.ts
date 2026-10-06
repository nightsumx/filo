// Capabilities are pi extensions shipped with the app (extensions/<entry>) and loaded per project
// with `-e`. They talk to the GUI through two channels only:
//   down: tool results and `onUpdate` carry `details` typed below (stored in the session file);
//   up:   the GUI runs hidden extension commands (`/gui-…`), which pi executes even mid-run.
// Mode state (approval mode, plan on/off) comes down as `ctx.ui.setStatus` under GUI_STATUS keys.
// Extensions import these types with `import type` only, so they stay loadable without this file.
import type { AgentMessage, AssistantMessage } from './pi'

export type CapabilityId = 'todo' | 'ask' | 'approval' | 'plan' | 'subagent'

export interface Capability {
    id: CapabilityId
    label: string
    description: string
    /** Extension file relative to the extensions directory. */
    entry: string
    /** Tools the extension registers; their calls get dedicated views in the transcript. */
    tools: string[]
    /** Approximate tokens added to every request (tool schema + prompt lines); checked by tests. */
    contextTokens: number
}

export const CAPABILITIES: readonly Capability[] = [
    {
        id: 'todo',
        label: '任务清单',
        description: '多步骤任务时维护一份清单，进度显示在输入框上方。',
        entry: 'todo.ts',
        tools: ['todo'],
        contextTokens: 230,
    },
    {
        id: 'ask',
        label: '向你提问',
        description: '需求不清时，在对话里弹出选择题让你回答，而不是自己猜。',
        entry: 'ask.ts',
        tools: ['ask'],
        contextTokens: 220,
    },
    {
        id: 'approval',
        label: '操作确认',
        description: '改文件、跑命令前先问你，可以在输入框旁切换为自动编辑或全自动。',
        entry: 'approval.ts',
        tools: [],
        contextTokens: 0,
    },
    {
        id: 'plan',
        label: '计划模式',
        description: '先只读探索、写出计划，你批准后再动手。在输入框旁切换。',
        entry: 'plan.ts',
        tools: ['propose_plan'],
        contextTokens: 0,
    },
    {
        id: 'subagent',
        label: '子 Agent',
        description: '把独立的子任务交给另一个 pi 进程并行完成，可以中途引导或取消。',
        entry: 'subagent.ts',
        tools: ['subagent'],
        contextTokens: 300,
    },
]

export interface CapabilityPreset {
    id: string
    label: string
    hint: string
    capabilities: readonly CapabilityId[]
}

export const PRESETS: readonly CapabilityPreset[] = [
    { id: 'lean', label: '精简', hint: '只用 pi 本身的能力，上下文最小。', capabilities: [] },
    { id: 'standard', label: '标准', hint: '适合日常开发。', capabilities: ['todo', 'ask', 'approval', 'plan'] },
    { id: 'full', label: '完整', hint: '再加上子 Agent，适合大任务。', capabilities: ['todo', 'ask', 'approval', 'plan', 'subagent'] },
]

export const DEFAULT_CAPABILITIES: readonly CapabilityId[] = PRESETS.find(p => p.id === 'standard')!.capabilities

/** Valid ids only, deduplicated, in CAPABILITIES order (so equal sets compare equal). */
export function normalizeCapabilities(value: unknown): CapabilityId[] {
    const wanted = new Set(Array.isArray(value) ? value : [])
    return CAPABILITIES.filter(c => wanted.has(c.id)).map(c => c.id)
}

/** Tool name → capability, for transcript rendering. */
export const CAPABILITY_TOOLS: ReadonlyMap<string, CapabilityId> = new Map(CAPABILITIES.flatMap(c => c.tools.map(t => [t, c.id] as const)))

/** Hidden commands are filtered out of the slash menu. */
export const GUI_COMMAND_PREFIX = 'gui-'

export interface GuiCommands {
    /** `/gui-ask-answer <toolCallId> <AskResponse JSON>` */
    askAnswer: 'gui-ask-answer'
    /** `/gui-approval <ApprovalMode>` */
    approval: 'gui-approval'
    /** `/gui-plan on|off` */
    plan: 'gui-plan'
    /** `/gui-plan-decide <toolCallId> <PlanDecision JSON>` */
    planDecide: 'gui-plan-decide'
    /** `/gui-subagent-steer <toolCallId> <message>` */
    subagentSteer: 'gui-subagent-steer'
    /** `/gui-subagent-cancel <toolCallId>` */
    subagentCancel: 'gui-subagent-cancel'
}

/** `ctx.ui.setStatus` keys carrying mode state; hidden from the status list. */
export const GUI_STATUS = {
    /** Current ApprovalMode. */
    approval: 'gui-approval',
    /** `on` while plan mode is on; cleared otherwise. */
    plan: 'gui-plan',
} as const

// ---------------------------------------------------------------- todo

export type TodoStatus = 'pending' | 'in_progress' | 'done'

export interface TodoItem {
    text: string
    status: TodoStatus
}

/** Every todo call replaces the whole list, so the latest result on the branch is the state. */
export interface TodoDetails {
    kind: 'todo'
    items: TodoItem[]
}

// ---------------------------------------------------------------- ask

export interface AskQuestion {
    id: string
    question: string
    /** Choices; the user can always type their own answer instead. */
    options: string[]
    multiple?: boolean
}

export interface AskAnswer {
    selected: string[]
    /** Free-text answer, used alone or alongside choices. */
    text?: string
}

/** What the GUI sends back through `/gui-ask-answer`. */
export type AskResponse =
    | { answers: Record<string, AskAnswer> }
    | { cancelled: true }

export type AskDetails =
    | { kind: 'ask', status: 'pending', questions: AskQuestion[] }
    | { kind: 'ask', status: 'answered', questions: AskQuestion[], answers: Record<string, AskAnswer> }
    | { kind: 'ask', status: 'cancelled', questions: AskQuestion[] }

// ---------------------------------------------------------------- approval

/**
 * ask: every call that can change something; edits: file edits inside the project go through, the
 * rest asks; auto: nothing asks (pi's own behaviour).
 */
export type ApprovalMode = 'ask' | 'edits' | 'auto'

export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'edits', 'auto']

/**
 * An approval is an extension `select` dialog whose title is this prefix plus ApprovalRequest JSON,
 * and whose options are ApprovalChoice values. The GUI renders it as an approval prompt.
 */
export const APPROVAL_TITLE_PREFIX = 'gui-approval '

export interface ApprovalRequest {
    toolCallId: string
    tool: string
    /** The command, path or arguments, one line. */
    summary: string
    /** What "always" allows in this thread: a bash program name, or the tool name. */
    scope: string
    /** Set when a subagent's call is forwarded: the subagent's title. */
    agent?: string
}

export type ApprovalChoice = 'allow' | 'always' | 'deny'

// ---------------------------------------------------------------- plan

/** What the GUI sends back through `/gui-plan-decide`. */
export type PlanDecision =
    | { approve: true }
    | { feedback: string }
    | { cancelled: true }

export type PlanDetails =
    | { kind: 'plan', status: 'pending' | 'approved' | 'cancelled', plan: string }
    | { kind: 'plan', status: 'revised', plan: string, feedback: string }

// ---------------------------------------------------------------- subagent

export interface SubagentUsage {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
}

/** A child tool call still running, keyed by its tool call id. */
export interface SubagentToolState {
    startedAt: number
    /** Latest partial result (`onUpdate`), e.g. bash output so far. */
    partial?: { content: { type: string, text?: string }[], details?: unknown }
}

/**
 * The subagent's whole run, streamed on every change. `messages` is the child transcript with tool
 * results clipped, so the GUI renders it with the same components as the parent.
 */
export interface SubagentDetails {
    kind: 'subagent'
    status: 'running' | 'done' | 'failed' | 'cancelled'
    title: string
    task: string
    /** provider/model the child runs. */
    model?: string
    messages: AgentMessage[]
    streaming?: AssistantMessage
    tools: Record<string, SubagentToolState>
    /** Steering messages sent but not yet delivered to the child. */
    steering: string[]
    usage: SubagentUsage
    startedAt: number
    endedAt?: number
    error?: string
}
