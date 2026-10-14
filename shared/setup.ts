// The setup assistant (src/features/Setup): the tools it checks for and installs with their official
// installers, run visibly in a terminal, and the agents a new thread can start with by default.
import type { AgentKind } from './agents'

/** Bumped when the assistant gains a step everyone should see once. */
export const SETUP_VERSION = 1

export type SetupToolId = 'node' | 'pi' | 'claude' | 'codex' | 'grok'

export const SETUP_TOOL_IDS: readonly SetupToolId[] = ['node', 'pi', 'claude', 'codex', 'grok']

/** The agents the assistant offers as the default for new threads, in its order. */
export const DEFAULT_AGENT_CHOICES: readonly AgentKind[] = ['pi', 'codex', 'claude', 'grok']

/** The tool behind an agent choice. */
export const AGENT_TOOL: Partial<Record<AgentKind, SetupToolId>> = { pi: 'pi', codex: 'codex', claude: 'claude', grok: 'grok' }

export interface SetupTool {
    id: SetupToolId
    label: string
    /** Where the login shell (or the installer's usual folder) has it; absent: not installed. */
    path?: string
    version?: string
    /** The official installer this machine runs for it; absent: none the app can run here. */
    install?: string
}

export interface SetupProbe {
    tools: SetupTool[]
}
