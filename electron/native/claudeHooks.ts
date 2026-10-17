// Claude Code's hooks for the TUI threads: one HTTP endpoint on 127.0.0.1, a path per process.
//
// Each `claude` the app runs gets a `--settings` file naming these hooks, with a URL holding a random
// token; the endpoint passes each event to that process's adapter and answers at once with no
// decision, so the hooks only report (permissions are decided in the TUI). SessionStart takes no
// HTTP hooks (Claude Code skips them there), so it posts through curl; so does every event where
// the user's settings allow HTTP hooks only to listed URLs (`allowedHttpHookUrls`).

import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** The events the adapter follows; tool events match every tool. */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'MessageDisplay', 'PreCompact', 'PostCompact', 'SessionEnd'] as const
const MATCHED = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])
const BODY_LIMIT = 4 * 1024 * 1024
const PREFIX = '/claude-hook/'

export type HookHandler = (event: Record<string, any>) => void

let server: Server | null = null
let listening: Promise<number> | null = null
const handlers = new Map<string, HookHandler>()

function start(): Promise<number> {
    listening ??= new Promise<number>((resolve, reject) => {
        server = createServer((req, res) => {
            const handler = req.method === 'POST' && req.url?.startsWith(PREFIX) ? handlers.get(req.url.slice(PREFIX.length)) : undefined
            if (!handler) {
                res.writeHead(404).end()
                req.resume()
                return
            }
            const chunks: Buffer[] = []
            let size = 0
            req.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size <= BODY_LIMIT)
                    chunks.push(chunk)
            })
            req.on('end', () => {
                // No decision: Claude Code goes on as if the hook were not there.
                res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
                if (size > BODY_LIMIT)
                    return
                try {
                    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    if (event && typeof event === 'object')
                        handler(event)
                }
                catch {}
            })
        })
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server!.address()
            resolve(typeof address === 'object' && address ? address.port : 0)
        })
        server.unref()
    })
    return listening
}

/**
 * A process's hooks: the settings that name them, their URL, and `dispose` to stop taking its
 * events. `command` posts every event through curl (HTTP hooks limited to listed URLs by a policy).
 */
export async function registerHooks(handler: HookHandler, transport: 'http' | 'command' = 'http'): Promise<{ settings: Record<string, unknown>, url: string, dispose: () => void }> {
    const port = await start()
    const token = randomBytes(18).toString('base64url')
    handlers.set(token, handler)
    const url = `http://127.0.0.1:${port}${PREFIX}${token}`
    const http = { type: 'http', url, timeout: 5 }
    // The event comes on stdin; curl ships with macOS, Windows 10+ and every Linux desktop.
    const curl = { type: 'command', command: `curl -s -m 3 -X POST -H "content-type: application/json" --data-binary @- ${url}`, timeout: 5 }
    const hooks = Object.fromEntries(EVENTS.map(event => [event, [{ ...(MATCHED.has(event) ? { matcher: '*' } : {}), hooks: [event === 'SessionStart' || transport === 'command' ? curl : http] }]]))
    return {
        settings: { hooks },
        url,
        dispose: () => {
            handlers.delete(token)
        },
    }
}
