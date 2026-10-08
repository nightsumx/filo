// Shared interface for agent adapters: ACP agents, Codex app-server, Claude Code stream-json.
//
// Every adapter speaks pi RPC to the renderer (commands in, events out), but drives a different
// underlying protocol. The service layer and renderer treat them uniformly through this interface.

import type { AcpAgentCaps, AcpAgentSpec } from '@shared/agents'
import type { SessionItem } from '@shared/ipc'
import type { RpcResponse } from '@shared/pi'

/**
 * What the service layer uses. Every adapter must provide:
 * - ManagedAgent methods (request, write, stop) that speak pi RPC
 * - key (session key like acp:codex:<id>), cwd, spec, sessionId
 * - caps (agent capabilities, pushed to renderer for feature gating)
 * - ready (resolves when the session is open and events start flowing)
 * - snapshot() for replaying messages
 */
export interface AgentAdapter {
    readonly id: string
    /** Session key (e.g. acp:codex:<id>, acp:claude:<id>). */
    readonly key: string
    readonly cwd: string
    readonly spec: AcpAgentSpec
    /** The agent's own session id (thread id for Codex, session id for Claude). Can change on fork. */
    readonly sessionId: string
    readonly caps: AcpAgentCaps
    /** Resolves when the session is open (new or loaded) and events can flow. */
    readonly ready: Promise<void>

    /** Pi RPC command in, RpcResponse out. */
    request: (command: Record<string, unknown>) => Promise<RpcResponse>
    /** A record that gets no response (extension_ui_response for approvals). */
    write: (record: Record<string, unknown>) => void
    /** Stop the agent process. */
    stop: () => Promise<void>

    /**
     * The session's messages for replay and read-only views. Entry ids are stable positions
     * (0, 1, 2, …) so the same message always has the same id across live and replay.
     */
    snapshot: () => SessionItem[]
}

/**
 * Callbacks every adapter receives from the service layer.
 */
export interface AgentAdapterCallbacks {
    /** Push a pi event to the renderer. */
    onEvent: (agentId: string, event: import('@shared/pi').PiEvent) => void
    /** The agent process exited. */
    onExit: (agentId: string, info: import('@shared/ipc').AgentExitInfo) => void
    /**
     * The session exists (new or loaded). Called once after the first prompt or after session/load
     * finishes. `prompt` is set when the user just sent one; `title` and `name` when the agent
     * suggests them.
     */
    onSession?: (agent: AgentAdapter, change: { prompt?: string, title?: string, name?: string }) => void
    /**
     * The agent forked the session into a new one. The service layer must allocate a key for it
     * and return it, so the adapter can switch to that key.
     */
    onFork?: (agent: AgentAdapter, sessionId: string) => string
}

/**
 * Options every adapter needs when constructed.
 */
export interface AgentAdapterOptions {
    cwd: string
    /** Resume this session (the adapter loads its history); otherwise start a new one. */
    sessionId?: string
    /** Only replay the session for reading, then stop: no events, no prompts. */
    readOnly?: boolean
    /** Replayed history carries no times; its messages get this one (the session's last update). */
    replayTime?: number
}
