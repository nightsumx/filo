// The unix socket a capability extension (terminal, browser) uses to ask the app for something: one
// JSON line in, one JSON line out per connection. Only pi processes the app starts know the path and
// the token (the env names a capability gives it), and a request without the token is refused.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import net from 'node:net'
import { platform } from './platform'

const MAX_REQUEST = 64 * 1024

export interface Failure { ok: false, error: string }

export class ToolSocket<Request, Response> {
    readonly token = randomBytes(24).toString('hex')
    private server: net.Server | null = null

    /** `handle` gets the request as sent (token included); a throw becomes `{ ok: false, error }`. */
    constructor(
        readonly socketPath: string,
        private handle: (request: Request) => Promise<Response | Failure>,
        private envNames: { socket: string, token: string },
    ) {}

    async start() {
        platform.clearIpc(this.socketPath)
        const server = net.createServer(socket => this.connection(socket))
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(this.socketPath, () => {
                server.off('error', reject)
                resolve()
            })
        })
        platform.restrict(this.socketPath)
        this.server = server
    }

    /** What a pi the app starts gets, once the socket listens. */
    env(): Record<string, string> {
        return this.server ? { [this.envNames.socket]: this.socketPath, [this.envNames.token]: this.token } : {}
    }

    stop() {
        if (!this.server)
            return
        this.server.close()
        this.server = null
        platform.clearIpc(this.socketPath)
    }

    private connection(socket: net.Socket) {
        let buffer = ''
        socket.setEncoding('utf8')
        socket.on('error', () => {})
        socket.on('data', (chunk: string) => {
            buffer += chunk
            if (buffer.length > MAX_REQUEST) {
                socket.destroy()
                return
            }
            const nl = buffer.indexOf('\n')
            if (nl === -1)
                return
            const line = buffer.slice(0, nl)
            socket.removeAllListeners('data')
            void this.answer(line).then(response => socket.end(`${JSON.stringify(response)}\n`))
        })
    }

    private async answer(line: string): Promise<Response | Failure> {
        let request: any
        try {
            request = JSON.parse(line)
        }
        catch {
            return { ok: false, error: 'bad request' }
        }
        const token = Buffer.from(typeof request?.token === 'string' ? request.token : '')
        const expected = Buffer.from(this.token)
        if (token.length !== expected.length || !timingSafeEqual(token, expected))
            return { ok: false, error: 'not authorized' }
        try {
            return await this.handle(request)
        }
        catch (error: any) {
            return { ok: false, error: String(error?.message ?? error) }
        }
    }
}

function realpath(dir: string): string {
    try {
        return realpathSync(dir)
    }
    catch {
        return dir
    }
}

/**
 * pi reports its cwd as the OS resolved it (/private/tmp/x for /tmp/x); things are filed under the
 * project folder as the windows know it, so a request's cwd is mapped back to that.
 */
export function projectOf(cwd: string, projects: Iterable<string>): string {
    const real = realpath(cwd)
    for (const project of projects) {
        if (project === cwd || realpath(project) === real)
            return project
    }
    return cwd
}
