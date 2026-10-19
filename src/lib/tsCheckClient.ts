// The window's end of the type checker (src/lib/tsCheck.ts): it keeps the checker's copy of the project's
// files up to date by sending only what changed, and asks it for diagnostics. The checker runs in a Web Worker;
// where there is none (tests), or it cannot start, the same code runs in the window, so squiggles still appear.
import type { TsDiagnosticsRequest, TsDiagnosticsResult } from 'lite-monaco'
import type { CompilerOptions, Family, TsCheckApi } from './tsCheck'
import { TsChecker } from './tsCheck'

type Reply = { id: number, result?: unknown, error?: string } | { ready: true }

/** TsCheckApi over postMessage. */
class WorkerChecker implements TsCheckApi {
    private nextId = 0
    private readonly waiting = new Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>()
    ready = false

    constructor(private readonly worker: Worker, failed: (why: string) => void) {
        worker.addEventListener('message', ({ data }: MessageEvent<Reply>) => {
            if ('ready' in data) {
                this.ready = true
                return
            }
            const call = this.waiting.get(data.id)
            this.waiting.delete(data.id)
            if (data.error !== undefined)
                call?.reject(new Error(data.error))
            else
                call?.resolve(data.result)
        })
        // An error before the worker said it is up means it could not start; later ones are its own code throwing, and it goes on.
        worker.addEventListener('error', (e) => {
            if (!this.ready)
                failed(e.message || 'the worker did not start')
        })
        worker.addEventListener('messageerror', () => failed('a message could not be read'))
    }

    private send(method: keyof TsCheckApi, ...args: unknown[]) {
        this.worker.postMessage({ method, args })
    }

    private ask<T>(method: keyof TsCheckApi, ...args: unknown[]): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const id = ++this.nextId
            this.waiting.set(id, { resolve, reject })
            this.worker.postMessage({ id, method, args })
        })
    }

    /** Calls that were waiting for an answer from a worker that is gone. */
    abandon() {
        for (const call of this.waiting.values())
            call.reject(new Error('the checker moved'))
        this.waiting.clear()
        this.worker.terminate()
    }

    files(family: Family, set: Record<string, string>, del: string[]) {
        this.send('files', family, set, del)
    }

    resolutions(family: Family, table: Record<string, Record<string, string>>) {
        this.send('resolutions', family, table)
    }

    check(family: Family, req: TsDiagnosticsRequest, options: CompilerOptions) {
        return this.ask<TsDiagnosticsResult | null>('check', family, req, options)
    }

    forget(family: Family, fileName: string) {
        this.send('forget', family, fileName)
    }

    count(family: Family, files: string[], options: CompilerOptions) {
        return this.ask<Record<string, number>>('count', family, files, options)
    }
}

export class TsCheckClient {
    private target: TsCheckApi | null = null
    /** What the checker has been told, to tell it only what is new, and to start another from it if the worker fails. */
    private readonly sent = new Map<Family, Map<string, string>>()
    private readonly sentResolutions = new Map<Family, string>()
    private readonly resolutionTables = new Map<Family, Record<string, Record<string, string>>>()

    constructor(private readonly useWorker: boolean = typeof Worker !== 'undefined') {}

    /** Where the type checking runs now: null until the first call. */
    get runsIn(): 'worker' | 'window' | null {
        return !this.target ? null : this.target instanceof WorkerChecker ? 'worker' : 'window'
    }

    /** Where the calls go; the worker is started by the first of them. */
    private get api(): TsCheckApi {
        if (this.target)
            return this.target
        if (this.useWorker) {
            try {
                const worker = new Worker(new URL('../workers/tsCheck.worker.ts', import.meta.url), { type: 'module' })
                const checker: WorkerChecker = new WorkerChecker(worker, (why) => {
                    if (this.target !== checker)
                        return
                    console.warn(`[filo] type checking moves to the window: ${why}`)
                    this.fallBack()
                    checker.abandon()
                })
                this.target = checker
                return checker
            }
            catch (e) {
                console.warn('[filo] type checking runs in the window:', e)
            }
        }
        this.target = new TsChecker()
        return this.target
    }

    /** Starts a checker in the window and tells it everything the worker had been told. */
    private fallBack() {
        const local = new TsChecker()
        for (const [family, files] of this.sent)
            local.files(family, Object.fromEntries(files), [])
        for (const [family, table] of this.resolutionTables)
            local.resolutions(family, table)
        this.target = local
    }

    /** The call, once more on the window's checker when the worker it was sent to failed under it. */
    private async run<T>(call: (api: TsCheckApi) => Promise<T>): Promise<T> {
        const api = this.api
        try {
            return await call(api)
        }
        catch (e) {
            if (this.target !== api)
                return call(this.target!)
            throw e
        }
    }

    /** The family's files as they are now (setTsFiles' table): the checker gets what differs from the last. */
    setFiles(family: Family, table: Record<string, string>) {
        const had = this.sent.get(family) ?? new Map<string, string>()
        this.sent.set(family, had)
        const set: Record<string, string> = {}
        const del: string[] = []
        let changed = false
        for (const [file, text] of Object.entries(table)) {
            if (had.get(file) !== text) {
                set[file] = text
                had.set(file, text)
                changed = true
            }
        }
        for (const file of had.keys()) {
            if (!(file in table)) {
                del.push(file)
                had.delete(file)
                changed = true
            }
        }
        if (changed)
            this.api.files(family, set, del)
    }

    setResolutions(family: Family, table: Record<string, Record<string, string>>) {
        const key = JSON.stringify(table)
        if (this.sentResolutions.get(family) === key)
            return
        this.sentResolutions.set(family, key)
        this.resolutionTables.set(family, table)
        this.api.resolutions(family, table)
    }

    check(family: Family, req: TsDiagnosticsRequest, options: CompilerOptions): Promise<TsDiagnosticsResult | null> {
        return this.run(api => api.check(family, req, options))
    }

    forget(family: Family, fileName: string) {
        this.api.forget(family, fileName)
    }

    count(family: Family, files: string[], options: CompilerOptions): Promise<Record<string, number>> {
        return this.run(api => api.count(family, files, options))
    }
}

export const tsChecker = new TsCheckClient()
