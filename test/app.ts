// Shared pieces of the end-to-end scripts: launch the built app with remote debugging, reach each
// window's store (exposed as window.__app with PI_GUI_TEST) over CDP, and poll for state.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
export const PORT = 9336

export class Page {
    private next = 0
    constructor(private ws: WebSocket, readonly id: string) {}

    static async connect(target: { id: string, webSocketDebuggerUrl: string }): Promise<Page> {
        const ws = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
        return new Page(ws, target.id)
    }

    evaluate<T>(expression: string): Promise<T> {
        const id = ++this.next
        return new Promise((resolve, reject) => {
            const onMessage = (e: MessageEvent) => {
                const msg = JSON.parse(String(e.data))
                if (msg.id !== id)
                    return
                this.ws.removeEventListener('message', onMessage)
                const { result, exceptionDetails } = msg.result ?? {}
                if (msg.error || exceptionDetails)
                    reject(new Error(msg.error?.message ?? exceptionDetails.exception?.description ?? exceptionDetails.text))
                else
                    resolve(result.value)
            }
            this.ws.addEventListener('message', onMessage)
            this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true } }))
        })
    }

    /** Raw CDP command. */
    call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = ++this.next
        return new Promise((resolve, reject) => {
            const onMessage = (e: MessageEvent) => {
                const msg = JSON.parse(String(e.data))
                if (msg.id !== id)
                    return
                this.ws.removeEventListener('message', onMessage)
                if (msg.error)
                    reject(new Error(msg.error.message))
                else
                    resolve(msg.result)
            }
            this.ws.addEventListener('message', onMessage)
            this.ws.send(JSON.stringify({ id, method, params }))
        })
    }

    /** PNG of the page at a fixed size, for looking at the result. */
    async screenshot(file: string, width = 1280, height = 760) {
        const { writeFile } = await import('node:fs/promises')
        await this.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await new Promise(r => setTimeout(r, 300))
        const { data } = await this.call<{ data: string }>('Page.captureScreenshot', { format: 'png' })
        await writeFile(file, Buffer.from(data, 'base64'))
    }

    close() {
        this.ws.close()
    }
}

export async function until<T>(what: string, probe: () => Promise<T | undefined | false | null>, timeoutMs = 20_000): Promise<T> {
    const end = Date.now() + timeoutMs
    for (;;) {
        const value = await probe().catch(() => undefined)
        if (value)
            return value
        if (Date.now() > end)
            throw new Error(`timed out waiting for: ${what}`)
        await new Promise(r => setTimeout(r, 150))
    }
}

/** Every app window, once its store has loaded, keyed by the projects it shows. */
export async function windows(count: number): Promise<{ page: Page, projects: string[] }[]> {
    return until(`${count} window(s)`, async () => {
        const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as any[]).filter(t => t.type === 'page')
        if (targets.length !== count)
            return undefined
        const list = []
        for (const t of targets) {
            const page = await Page.connect(t)
            const projects = await page.evaluate<string[] | null>('window.__app?.env ? [...window.__app.windowProjects] : null')
            if (!projects) {
                page.close()
                return undefined
            }
            list.push({ page, projects })
        }
        return list
    })
}

export function check(ok: boolean, message: string) {
    if (!ok)
        throw new Error(`FAIL: ${message}`)
    console.log(`ok - ${message}`)
}

/** Off-screen and never focused (electron/background.ts), so a run doesn't take over the computer; PI_E2E_SHOW=1 to watch it. */
export const BACKGROUND_ENV: Record<string, string> = process.env.PI_E2E_SHOW === '1' ? {} : { PI_GUI_BACKGROUND: '1' }

/** Starts the built app; PI_E2E_APP runs a packaged one instead (…/Filo.app/Contents/MacOS/Filo). */
export async function launch(env: Record<string, string>) {
    // The electron package's main export is the binary path; the .bin shim would outlive kill().
    const packaged = process.env.PI_E2E_APP
    const electron = packaged || createRequire(import.meta.url)('electron') as string
    const args = packaged ? [`--remote-debugging-port=${PORT}`] : ['.', `--remote-debugging-port=${PORT}`]
    const app = spawn(electron, args, { cwd: ROOT, env: { ...process.env, ...BACKGROUND_ENV, ...env }, stdio: 'ignore' })
    return async () => {
        const exited = new Promise(resolve => app.once('exit', resolve))
        app.kill('SIGTERM')
        await Promise.race([exited, new Promise(r => setTimeout(r, 3000))])
        if (app.exitCode === null && app.signalCode === null)
            app.kill('SIGKILL')
    }
}

