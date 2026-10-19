// The browser capability for the agents that are not pi. pi loads it as an extension; Codex, Claude Code
// and the ACP agents get the same tools from a small MCP server (packages/capabilities/mcp/browser.mjs)
// that Filo starts for each thread through the agent's own MCP setting. The server only forwards to
// the app's browser socket (browserTools.ts), so a page any agent opens is a tab in the Browser panel.
import type { McpServerConfig } from './acp/adapter'
import { ENV, normalizeCapabilities } from '@shared/capabilities'
import { randomUUID } from 'node:crypto'
import process from 'node:process'

export const BROWSER_MCP_NAME = 'filo-browser'

export interface BrowserMcpOptions {
    /** mcp/browser.mjs: a real file, outside the asar when packaged (the agent runs it). */
    script: string
    /** The socket and token the app's browser tools listen with (BrowserTools.env()). */
    env: () => Record<string, string>
}

/**
 * The server a thread of `cwd` gets, or nothing when the browser capability is off. It runs on the
 * app's own Electron as plain node (ELECTRON_RUN_AS_NODE), which every install has; the agent's
 * node may be missing or old. Each thread is its own caller there: its own tab.
 */
export function browserMcpServers(options: BrowserMcpOptions, capabilities: unknown, cwd: string, agent: string): McpServerConfig[] {
    if (!normalizeCapabilities(capabilities).includes('browser'))
        return []
    const env = options.env()
    if (!env[ENV.browser])
        return []
    return [{
        name: BROWSER_MCP_NAME,
        command: process.execPath,
        args: [options.script],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', [ENV.browserCwd]: cwd, [ENV.browserSession]: `${agent}-${randomUUID()}` },
    }]
}
