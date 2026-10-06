// Wire protocol between the capability extensions and their hosts (the desktop app, pi-cc-tui).
//   down: tool results and `onUpdate` carry `details` typed below (stored in the session file);
//   up:   the desktop app runs hidden extension commands (`/gui-…`), which pi executes even mid-run.
// Mode state (approval mode, plan on/off) goes down as `ctx.ui.setStatus` under GUI_STATUS keys, and
// to other extensions in the same pi as GUI_EVENTS on `pi.events`.
// Extensions import these with `import type` only; the event names and env vars are repeated there.

export type CapabilityId = 'todo' | 'ask' | 'approval' | 'plan' | 'subagent'

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

/**
 * `pi.events` channels for extensions running in the same pi (pi-cc-tui's status line and mode key).
 * The capabilities emit `*:mode` whenever the state is published, and listen on `*:set`.
 */
export const GUI_EVENTS = {
    /** ApprovalMode, emitted by approval. */
    approvalMode: 'gui-approval:mode',
    /** ApprovalMode to switch to. */
    approvalSet: 'gui-approval:set',
    /** boolean: plan mode on, emitted by plan. */
    planMode: 'gui-plan:mode',
    /** boolean: plan mode to switch to. */
    planSet: 'gui-plan:set',
} as const

/** Environment variables shared by the hosts and the capabilities. */
export const ENV = {
    /** Set to `gui` by the desktop app: it loads the capabilities itself, so pi-cc-tui's copies stay off. */
    host: 'PI_KIT_HOST',
    /** Set for a subagent's pi: capabilities that need the user (ask, plan, subagent) stay off. */
    subagent: 'PI_KIT_SUBAGENT',
    /** Approval mode a subagent's pi starts in, when approval is loaded without `-e`. */
    approvalMode: 'PI_KIT_APPROVAL_MODE',
} as const

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
    /** Present-tense label shown while the step runs ("Running tests"); optional. */
    activeForm?: string
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
export interface SubagentDetails<Message = unknown, Streaming = unknown> {
    kind: 'subagent'
    status: 'running' | 'done' | 'failed' | 'cancelled'
    title: string
    task: string
    /** provider/model the child runs. */
    model?: string
    messages: Message[]
    streaming?: Streaming
    tools: Record<string, SubagentToolState>
    /** Steering messages sent but not yet delivered to the child. */
    steering: string[]
    usage: SubagentUsage
    startedAt: number
    endedAt?: number
    error?: string
}
