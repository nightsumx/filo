// Capabilities are pi extensions shipped with the app (extensions/<entry>) and loaded per project
// with `-e`. They talk to the GUI through two channels only:
//   down: tool results and `onUpdate` carry `details` typed below (stored in the session file);
//   up:   the GUI runs hidden extension commands (`/gui-…`), which pi executes even mid-run.
// Extensions import these types with `import type` only, so they stay loadable without this file.

export type CapabilityId = 'todo' | 'ask'

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
]

export interface CapabilityPreset {
    id: string
    label: string
    hint: string
    capabilities: readonly CapabilityId[]
}

export const PRESETS: readonly CapabilityPreset[] = [
    { id: 'lean', label: '精简', hint: '只用 pi 本身的能力，上下文最小。', capabilities: [] },
    { id: 'standard', label: '标准', hint: '适合日常开发。', capabilities: ['todo', 'ask'] },
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
}

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
