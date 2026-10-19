// Type checking for the editor, away from the window's thread. A TsChecker owns lite-monaco's TypeScript
// service for each language family and answers two questions about it: the diagnostics of one open file
// (the squiggles) and how many errors files have (the tree's marks). It is plain code with no worker
// globals: src/workers/tsCheck.worker.ts runs one in a Web Worker, and tsCheckClient.ts falls back to one in
// the window (tests, or a worker that cannot start). The service is fed the same file table, resolutions and
// options as the window's own service (src/store/codeIntel.ts publishes to both), so both see one project.
// The compiler options come with each request, those of the tsconfig the file belongs to, so the packages of
// one folder are each checked the way their own tsconfig says.
import type { TsDiagnosticsRequest, TsDiagnosticsResult } from 'lite-monaco'
import { computeTsDiagnostics, getTSService, setTsCompilerOptions, setTsFiles, setTsResolutions } from 'lite-monaco'

export type Family = 'typescript' | 'javascript'
export type CompilerOptions = Parameters<typeof setTsCompilerOptions>[0]

/** What lite-monaco's service uses for an option nobody set, to go back to when a project that set it is gone. */
export const SERVICE_DEFAULTS: CompilerOptions = { strict: true, esModuleInterop: true, allowSyntheticDefaultImports: true, skipLibCheck: true, useDefineForClassFields: true, checkJs: false }

/**
 * The options a family's service holds. `apply` turns "these are the options now" into what `setTsCompilerOptions`
 * needs: the options to set, and the ones an earlier call set that are not wanted any more, back to the service's own.
 */
export class OptionState {
    private readonly applied = new Map<Family, Set<string>>()

    apply(family: Family, next: CompilerOptions): CompilerOptions {
        const reset: CompilerOptions = {}
        for (const key of this.applied.get(family) ?? []) {
            if (!(key in next))
                reset[key] = SERVICE_DEFAULTS[key]
        }
        this.applied.set(family, new Set(Object.keys(next)))
        return { ...reset, ...next }
    }
}

/** What the window can ask of the checker. Calls without a result are fire-and-forget. */
export interface TsCheckApi {
    /** Changes to a family's file table: files that are new or have new text, and files that are gone. */
    files: (family: Family, set: Record<string, string>, del: string[]) => void
    resolutions: (family: Family, table: Record<string, Record<string, string>>) => void
    /** Diagnostics of an open file, from the text the editor holds, under these compiler options. Null: nothing to report (the service failed). */
    check: (family: Family, req: TsDiagnosticsRequest, options: CompilerOptions) => Promise<TsDiagnosticsResult | null>
    /** The editor of this file is gone: its text no longer stands in for the file's. */
    forget: (family: Family, fileName: string) => void
    /** Errors per file (files without any are left out), for files the project holds. */
    count: (family: Family, files: string[], options: CompilerOptions) => Promise<Record<string, number>>
}

/** A file name the service never sees a text for: asking it for a service is all it is good for. */
const PROBE = '/__filo_check__.ts'

export class TsChecker implements TsCheckApi {
    private readonly tables = new Map<Family, Record<string, string>>()
    /** Files an editor's text stands in for, and how to let go of them. */
    private readonly held = new Map<string, () => void>()
    private readonly options = new OptionState()

    /** The service checks under these options (no change, no work). */
    private use(family: Family, options: CompilerOptions) {
        setTsCompilerOptions(this.options.apply(family, options), { lang: family })
    }

    files(family: Family, set: Record<string, string>, del: string[]) {
        const table = this.tables.get(family) ?? {}
        this.tables.set(family, table)
        Object.assign(table, set)
        for (const file of del)
            delete table[file]
        setTsFiles(table, { lang: family })
    }

    resolutions(family: Family, table: Record<string, Record<string, string>>) {
        setTsResolutions(table, { lang: family })
    }

    async check(family: Family, req: TsDiagnosticsRequest, options: CompilerOptions): Promise<TsDiagnosticsResult | null> {
        this.use(family, options)
        const session = getTSService({ lang: family, fileName: req.fileName })
        const key = `${family}\0${session.fileName}`
        if (!this.held.has(key))
            this.held.set(key, session.acquire())
        session.update(req.text)
        const service = await session.ensure().catch(() => null)
        const ts = session.ts()
        if (!service || !ts)
            return null
        // Another request may have put newer text in while the service loaded; this one is answered for the text it came with.
        session.update(req.text)
        return computeTsDiagnostics(service, ts, session.fileName, req.text.length, req.mode === 'syntax', req.wantTags, req.options)
    }

    forget(family: Family, fileName: string) {
        const key = `${family}\0${getTSService({ lang: family, fileName }).fileName}`
        this.held.get(key)?.()
        this.held.delete(key)
    }

    async count(family: Family, files: string[], options: CompilerOptions): Promise<Record<string, number>> {
        this.use(family, options)
        const session = getTSService({ lang: family, fileName: PROBE })
        const service = await session.ensure().catch(() => null)
        const ts = session.ts()
        const out: Record<string, number> = {}
        if (!service || !ts)
            return out
        for (const file of files) {
            try {
                const errors = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].filter(d => d.category === ts.DiagnosticCategory.Error).length
                if (errors)
                    out[file] = errors
            }
            catch {}
        }
        return out
    }
}
