// Capabilities are pi extensions from the pi-capabilities workspace package, loaded per project with
// `-e`. This file is the app's catalog of them (labels, presets); the wire protocol they speak lives
// in the package and is re-exported here.
import type { ReviewDetails as ReviewDetailsOf, SubagentDetails as SubagentDetailsOf } from 'pi-capabilities/protocol'
import type { Localized } from './i18n'
import type { AgentMessage, AssistantMessage } from './pi'
import type { CapabilityId } from 'pi-capabilities/protocol'

export * from 'pi-capabilities/protocol'
export type SubagentDetails = SubagentDetailsOf<AgentMessage, AssistantMessage>
export type ReviewDetails = ReviewDetailsOf<AgentMessage, AssistantMessage>

export interface Capability {
    id: CapabilityId
    label: Localized
    description: Localized
    /** Extension file relative to the package's extensions directory. */
    entry: string
    /** Tools the extension registers; their calls get dedicated views in the transcript. */
    tools: string[]
    /** Approximate tokens added to every request (tool schema + prompt lines); checked by tests. */
    contextTokens: number
}

export const CAPABILITIES: readonly Capability[] = [
    {
        id: 'todo',
        label: { zh: '任务清单', en: 'Todo list' },
        description: { zh: '多步骤任务时维护一份清单，进度显示在输入框上方。', en: 'Keeps a checklist for multi-step work, with progress shown above the input.' },
        entry: 'todo.ts',
        tools: ['todo'],
        contextTokens: 230,
    },
    {
        id: 'ask',
        label: { zh: '向你提问', en: 'Ask you' },
        description: { zh: '需求不清时，在对话里弹出选择题让你回答，而不是自己猜。', en: 'When something is unclear, asks you multiple-choice questions in the conversation instead of guessing.' },
        entry: 'ask.ts',
        tools: ['ask'],
        contextTokens: 220,
    },
    {
        id: 'approval',
        label: { zh: '操作确认', en: 'Approvals' },
        description: { zh: '默认全自动；在输入框旁切换为每次确认或自动编辑后，改文件、跑命令前会先问你。', en: 'Full auto by default. Switch to Ask every time or Auto-edit next to the input to be asked before file edits and commands.' },
        entry: 'approval.ts',
        tools: [],
        contextTokens: 0,
    },
    {
        id: 'plan',
        label: { zh: '计划模式', en: 'Plan mode' },
        description: { zh: '先只读探索、写出计划，你批准后再动手。在输入框旁切换。', en: 'Explores read-only and writes a plan; changes start once you approve it. Toggle it next to the input.' },
        entry: 'plan.ts',
        tools: ['propose_plan'],
        contextTokens: 0,
    },
    {
        id: 'subagent',
        label: { zh: '子 Agent', en: 'Subagents' },
        description: { zh: '把独立的子任务交给另一个 pi 进程并行完成，可以中途引导或取消。', en: 'Hands independent subtasks to another pi process running in parallel, which you can steer or cancel.' },
        entry: 'subagent.ts',
        tools: ['subagent'],
        contextTokens: 300,
    },
    {
        id: 'review',
        label: { zh: '审查', en: 'Review' },
        description: { zh: '每轮结束后可点 Review，让一个独立的 pi 进程只读审查改动、跑命令取证，你挑选结果交回给 Agent。', en: 'Click Review after a turn: a separate pi process audits the changes read-only, runs commands for evidence, and you pick what goes back to the agent.' },
        entry: 'review.ts',
        tools: [],
        contextTokens: 0,
    },
]

export interface CapabilityPreset {
    id: string
    label: Localized
    hint: Localized
    capabilities: readonly CapabilityId[]
}

export const PRESETS: readonly CapabilityPreset[] = [
    { id: 'lean', label: { zh: '精简', en: 'Lean' }, hint: { zh: '只用 pi 本身的能力，上下文最小。', en: 'Only what pi has built in; the smallest context.' }, capabilities: [] },
    { id: 'standard', label: { zh: '标准', en: 'Standard' }, hint: { zh: '适合日常开发。', en: 'For everyday development.' }, capabilities: ['todo', 'ask', 'approval', 'plan', 'review'] },
    { id: 'full', label: { zh: '完整', en: 'Full' }, hint: { zh: '再加上子 Agent，适合大任务。', en: 'Adds subagents, for large tasks.' }, capabilities: ['todo', 'ask', 'approval', 'plan', 'subagent', 'review'] },
]

export const DEFAULT_CAPABILITIES: readonly CapabilityId[] = PRESETS.find(p => p.id === 'standard')!.capabilities

const sameSet = (a: readonly CapabilityId[], b: readonly CapabilityId[]) => a.length === b.length && a.every(id => b.includes(id))

/** The preset with exactly these capabilities, if any. */
export function presetOf(ids: readonly CapabilityId[]): CapabilityPreset | undefined {
    return PRESETS.find(p => sameSet(p.capabilities, ids))
}

/**
 * Capabilities added after Settings started saving presets by id. A list saved by an older build
 * could not include them, so it is still the preset it was without them.
 */
const NEWER_THAN_LISTS: readonly CapabilityId[] = ['review']

/** A saved choice (preset id, list, or anything unreadable) → the ids it enables. */
export function resolveCapabilities(saved: unknown): { ids: CapabilityId[], preset?: string } {
    if (typeof saved === 'string') {
        const preset = PRESETS.find(p => p.id === saved) ?? PRESETS.find(p => sameSet(p.capabilities, DEFAULT_CAPABILITIES))!
        return { ids: [...preset.capabilities], preset: preset.id }
    }
    if (!Array.isArray(saved)) {
        const preset = presetOf(DEFAULT_CAPABILITIES)
        return { ids: [...DEFAULT_CAPABILITIES], preset: preset?.id }
    }
    const list = normalizeCapabilities(saved)
    const preset = presetOf(list) ?? PRESETS.find(p => p.capabilities.length && sameSet(p.capabilities.filter(id => !NEWER_THAN_LISTS.includes(id)), list))
    return preset ? { ids: [...preset.capabilities], preset: preset.id } : { ids: list }
}

/** Valid ids only, deduplicated, in CAPABILITIES order (so equal sets compare equal). */
export function normalizeCapabilities(value: unknown): CapabilityId[] {
    const wanted = new Set(Array.isArray(value) ? value : [])
    return CAPABILITIES.filter(c => wanted.has(c.id)).map(c => c.id)
}

/** Tool name → capability, for transcript rendering. */
export const CAPABILITY_TOOLS: ReadonlyMap<string, CapabilityId> = new Map(CAPABILITIES.flatMap(c => c.tools.map(t => [t, c.id] as const)))

