// The capability catalog: what each extension is called, what it costs, and the presets. Shared by the
// desktop app (Settings → Capabilities) and pi-cc-tui (/capabilities); which ones are on lives in
// pi's settings.json (SETTINGS_KEY below; lib/settings.ts reads the file), so both hosts load the same set.
import type { ApprovalMode, CapabilityId } from '../protocol'
import { APPROVAL_MODES } from '../protocol'

/** Text in both UI languages. */
export interface Localized { zh: string, en: string }

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
    /** Needs the desktop app (its Terminal or Browser panel): pi in a terminal (pi-cc-tui) never loads it. */
    appOnly?: true
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
    {
        id: 'autopilot',
        label: { zh: '自动驾驶', en: 'Autopilot' },
        description: { zh: '打开后，每轮结束由一个独立的 pi 按你的规则库检查结果并替你回复；花钱、发布、删除和需要你拍板的事会变成卡片等你决定。', en: 'When on, a separate pi checks each finished turn against your rulebook and replies for you; spending, releases, deletions and calls only you can make become cards that wait for you.' },
        entry: 'autopilot.ts',
        tools: [],
        contextTokens: 0,
    },
    {
        id: 'budget',
        label: { zh: '花费上限', en: 'Spending limit' },
        description: { zh: '一次提问花到上限时（算上子 Agent 和自动驾驶替你发的消息），先停下来问你再继续。子 Agent 各自计算。按 pi 的价格表算，没有价格的模型不计。', en: 'When one prompt has cost the limit (subagents and autopilot\'s replies included), it stops to ask before going on. Each subagent counts its own. Uses pi\'s price list; models without prices count as free.' },
        entry: 'budget.ts',
        tools: [],
        contextTokens: 0,
    },
    {
        id: 'terminal',
        label: { zh: '终端', en: 'Terminals' },
        description: { zh: '开发服务器这类长时间运行的命令放进底部的终端里跑，你能看到、能输入、能关掉；Agent 也能读你自己终端里的输出。', en: 'Long-running commands like dev servers run in the Terminal panel, where you can watch, type into and close them; the agent can also read what your own terminals print.' },
        entry: 'terminal.ts',
        tools: ['terminal_run', 'terminal_read', 'terminal_stop'],
        contextTokens: 600,
        appOnly: true,
    },
    {
        id: 'browser',
        label: { zh: '浏览器', en: 'Browser' },
        description: { zh: 'Agent 能在右侧的浏览器面板里打开网页、读页面、点击、输入、截图、看控制台，用来验证它改的前端。你看得到，也能自己登录或接管。Codex、Claude Code 等线程通过 MCP 拿到同样的工具（新开的线程生效）。', en: 'The agent opens pages in the Browser panel on the right, reads them, clicks, types, takes screenshots and reads the console, to check the front end it changed. You can watch, log in yourself or take over. Codex, Claude Code and other agents get the same tools through MCP (new threads).' },
        entry: 'browser.ts',
        tools: ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_press', 'browser_select', 'browser_scroll', 'browser_wait', 'browser_eval', 'browser_console', 'browser_tabs'],
        contextTokens: 1450,
        appOnly: true,
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
    { id: 'standard', label: { zh: '标准', en: 'Standard' }, hint: { zh: '适合日常开发。', en: 'For everyday development.' }, capabilities: ['todo', 'ask', 'approval', 'plan', 'review', 'autopilot', 'budget', 'terminal'] },
    { id: 'full', label: { zh: '完整', en: 'Full' }, hint: { zh: '再加上子 Agent，适合大任务。', en: 'Adds subagents, for large tasks.' }, capabilities: ['todo', 'ask', 'approval', 'plan', 'subagent', 'review', 'autopilot', 'budget', 'terminal', 'browser'] },
]

/** Nothing saved: the full set, which is what pi-cc-tui loaded before the choice was shared. */
export const DEFAULT_CAPABILITIES: readonly CapabilityId[] = PRESETS.find(p => p.id === 'full')!.capabilities

const sameSet = (a: readonly CapabilityId[], b: readonly CapabilityId[]) => a.length === b.length && a.every(id => b.includes(id))

/** The preset with exactly these capabilities, if any. */
export function presetOf(ids: readonly CapabilityId[]): CapabilityPreset | undefined {
    return PRESETS.find(p => sameSet(p.capabilities, ids))
}

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
    return { ids: list, preset: presetOf(list)?.id }
}

/** Valid ids only, deduplicated, in CAPABILITIES order (so equal sets compare equal). */
export function normalizeCapabilities(value: unknown): CapabilityId[] {
    const wanted = new Set(Array.isArray(value) ? value : [])
    return CAPABILITIES.filter(c => wanted.has(c.id)).map(c => c.id)
}

// ---------------------------------------------------------------- the saved choice

/**
 * Where the choice lives: pi's own ~/.pi/agent/settings.json, so the desktop app and the terminal
 * load the same set. pi keeps keys it does not know when it saves its settings.
 *   "pi-capabilities": { "enabled": "full" | ["todo", …], "approvalMode": "auto", "budget": 5 }
 */
export const SETTINGS_KEY = 'pi-capabilities'

/** US dollars one prompt may cost before the budget capability asks, when none is saved. */
export const DEFAULT_BUDGET = 5

export interface CapabilityChoice {
    /** A preset id (so the preset's later additions apply) or a list. */
    enabled?: string | CapabilityId[]
    /** The approval mode new sessions start in. */
    approvalMode?: ApprovalMode
    /** US dollars per prompt for the budget capability. */
    budget?: number
}

/** The choice resolved: what loads, the preset it is (if any), and the approval mode for new sessions. */
export interface CapabilityState {
    ids: CapabilityId[]
    preset?: string
    approvalMode: ApprovalMode
    budget: number
    /** settings.json holds a choice; false: the defaults. */
    saved: boolean
}

/** The choice inside a parsed settings.json, whatever else it holds; undefined when there is none. */
export function capabilityChoice(settings: unknown): CapabilityChoice | undefined {
    const value = settings && typeof settings === 'object' ? (settings as Record<string, unknown>)[SETTINGS_KEY] : undefined
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined
    const { enabled, approvalMode, budget } = value as Record<string, unknown>
    return {
        enabled: typeof enabled === 'string' ? enabled : Array.isArray(enabled) ? normalizeCapabilities(enabled) : undefined,
        approvalMode: APPROVAL_MODES.includes(approvalMode as ApprovalMode) ? approvalMode as ApprovalMode : undefined,
        budget: isBudget(budget) ? budget : undefined,
    }
}

export function capabilityState(choice: CapabilityChoice | undefined): CapabilityState {
    const { ids, preset } = resolveCapabilities(choice?.enabled)
    return { ids, preset, approvalMode: choice?.approvalMode ?? 'auto', budget: choice?.budget ?? DEFAULT_BUDGET, saved: !!choice }
}

export const isBudget = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
