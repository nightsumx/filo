// Gives lite-monaco's TypeScript service the rest of the project it is editing a file of.
//
// The service keeps its own in-memory file table and resolves imports only inside it (relative paths,
// `/node_modules/<name>/index.d.ts`, `/<name>.ts`), so an editor tab that is just one file reports every
// import as "cannot find module". This reads what the file needs from disk and hands it over:
//  - module resolution is TypeScript's own (`resolveModuleName` with the project's tsconfig: paths, baseUrl,
//    package `exports`, @types, symlinked node_modules). It is synchronous, the disk is not, so a pass that
//    touches a file not read yet records it, the files are read, and the pass runs again until nothing is missing;
//  - what a non-relative import resolves to is filed where the service looks for that name, as a one-line file
//    re-exporting the real one;
//  - global declarations (`@types/*`, the project's own .d.ts) go in as root files.
import type { FileRead } from '@shared/ipc'
import type * as TS from 'typescript'

export type TsModule = typeof TS

export interface ProjectFs {
    read: (path: string) => Promise<FileRead>
    /** Where links lead; the path itself when it is not one. */
    realPath: (path: string) => Promise<string>
    /** TypeScript and JavaScript files under a folder (absolute paths). */
    sources: (root: string) => Promise<string[]>
    /** Names of the folders in a folder; none when it does not exist. */
    folders: (dir: string) => Promise<string[]>
}

export interface Limits {
    files: number
    bytes: number
}

export const DEFAULT_LIMITS: Limits = { files: 3000, bytes: 40 * 1024 * 1024 }

// ---------------------------------------------------------------------------------------------- paths

/** Forward slashes, no trailing slash. */
export const slashed = (p: string) => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
export const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0)) || '/'
/** The key the service files a path under. */
export const vpath = (p: string) => (p.startsWith('/') ? p : `/${p}`)
/** The real path behind a service key: `/C:/x` is `C:/x`, a POSIX path stays as it is. */
export const unvpath = (k: string) => (/^\/[a-z]:\//i.test(k) ? k.slice(1) : k)
const isRoot = (dir: string) => dir === '/' || dir === dirOf(dir) || /^[a-z]:\/?$/i.test(dir)

export function join(base: string, rel: string): string {
    const stack: string[] = []
    for (const part of `${base}/${rel}`.split('/')) {
        if (!part || part === '.')
            continue
        if (part === '..')
            stack.pop()
        else
            stack.push(part)
    }
    // A drive letter stays at the front (`C:/x`) rather than becoming `/C:/x`.
    return /^[a-z]:$/i.test(stack[0] ?? '') && !base.startsWith('/') ? stack.join('/') : `/${stack.join('/')}`
}

/** `fromDir` to `to`, as an import specifier (both absolute). */
export function relative(fromDir: string, to: string): string {
    const a = vpath(fromDir).split('/').filter(Boolean)
    const b = vpath(to).split('/').filter(Boolean)
    let i = 0
    while (i < a.length && i < b.length - 1 && a[i] === b[i])
        i++
    const rel = [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
    return rel.startsWith('.') ? rel : `./${rel}`
}

export const isNodeModules = (p: string) => p.includes('/node_modules/')
const SOURCE = /\.(?:[cm]?tsx?|jsx|[cm]?js)$/
const DECLARATION = /\.d\.[cm]?ts$/
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/
const ASSET = /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|json|txt|md|html|wasm|glsl|frag|vert|yaml|yml|toml|csv)(?:[?#].*)?$|[?!]/i

// ---------------------------------------------------------------------------------------------- config

/** The parts of a tsconfig.json that decide what a file is checked against. */
export interface Config {
    /** The tsconfig.json (or jsconfig.json) that applies; null when there is none. */
    path: string | null
    /** Its folder, or the fallback when there is none. */
    dir: string
    options: TS.CompilerOptions
    /** Whether the project's include/exclude/files list this file. */
    covers: (file: string) => boolean
}

function globToRegExp(dir: string, pattern: string): RegExp {
    let p = slashed(pattern).replace(/^\.\//, '')
    const last = p.split('/').pop() ?? ''
    // A bare folder name stands for everything in it.
    if (!/[*?]/.test(last) && !/\.[a-z]+$/i.test(last))
        p = `${p}/**/*`
    const joined = p.startsWith('/') || /^[a-z]:/i.test(p) ? p : `${dir}/${p}`
    // `../src/**/*` in a config one folder down: the dots go before the pattern is read.
    const parts: string[] = []
    for (const part of joined.split('/')) {
        if (part === '..' && parts.length > 1)
            parts.pop()
        else if (part !== '.')
            parts.push(part)
    }
    const abs = parts.join('/')
    let re = ''
    for (let i = 0; i < abs.length; i++) {
        const c = abs[i]
        if (c === '*' && abs[i + 1] === '*') {
            if (abs[i + 2] === '/') {
                re += '(?:.*/)?'
                i += 2
            }
            else {
                re += '.*'
                i++
            }
        }
        else if (c === '*') {
            re += '[^/]*'
        }
        else if (c === '?') {
            re += '[^/]'
        }
        else {
            re += c.replace(/[$()+.[\\\]^{|}]/g, '\\$&')
        }
    }
    return new RegExp(`^${re}$`)
}

interface RawConfig {
    dir: string
    options: TS.CompilerOptions
    /** `include`, `exclude` and `files` are relative to the config that wrote them, which an `extends` may not be. */
    include?: Scoped
    exclude?: Scoped
    files?: Scoped
    references: string[]
}

interface Scoped {
    dir: string
    list: string[]
}

export async function loadConfig(ts: TsModule, fs: ProjectFs, file: string, fallbackDir: string): Promise<Config> {
    const cache = new Map<string, Promise<RawConfig | null>>()

    const rawConfig = (path: string, chain: string[] = []): Promise<RawConfig | null> => {
        // A config that extends itself, through others or not, has nothing to inherit from there.
        if (chain.includes(path))
            return Promise.resolve(null)
        let hit = cache.get(path)
        if (!hit) {
            hit = (async () => {
                const read = await fs.read(path).catch(() => null)
                if (read?.kind !== 'text' || chain.length > 8)
                    return null
                const parsed = ts.parseConfigFileTextToJson(path, read.text)
                const json = parsed.config
                if (!json || typeof json !== 'object')
                    return null
                const dir = dirOf(path)
                const own = ts.convertCompilerOptionsFromJson(json.compilerOptions ?? {}, dir).options
                if (json.compilerOptions?.paths)
                    own.pathsBasePath = dir
                const parents: RawConfig[] = []
                for (const spec of [json.extends].flat().filter((s): s is string => typeof s === 'string')) {
                    const parent = await extendsTarget(spec, dir)
                    const loaded = parent ? await rawConfig(parent, [...chain, path]) : null
                    if (loaded)
                        parents.push(loaded)
                }
                const merged = Object.assign({}, ...parents.map(p => p.options), own) as TS.CompilerOptions
                const inherit = <K extends 'include' | 'exclude' | 'files'>(key: K): RawConfig[K] => Array.isArray(json[key]) ? { dir, list: json[key] } : parents.map(p => p[key]).findLast(v => v)
                return {
                    dir,
                    options: merged,
                    include: inherit('include'),
                    exclude: inherit('exclude'),
                    files: inherit('files'),
                    references: Array.isArray(json.references) ? json.references.map((r: any) => typeof r?.path === 'string' ? r.path : '').filter(Boolean) : [],
                }
            })()
            cache.set(path, hit)
        }
        return hit
    }

    const extendsTarget = async (spec: string, dir: string): Promise<string | null> => {
        const tries = (base: string) => [base, `${base}.json`, `${base}/tsconfig.json`]
        if (spec.startsWith('.') || spec.startsWith('/')) {
            for (const c of tries(join(dir, spec))) {
                if (c.endsWith('.json') && (await fs.read(c).catch(() => null))?.kind === 'text')
                    return c
            }
            return null
        }
        for (let d = dir; ; d = dirOf(d)) {
            for (const c of tries(`${d}/node_modules/${spec}`)) {
                if (c.endsWith('.json') && (await fs.read(c).catch(() => null))?.kind === 'text')
                    return c
            }
            if (isRoot(d))
                return null
        }
    }

    const coverage = (raw: RawConfig): ((f: string) => boolean) => {
        const excluded = raw.exclude ?? { dir: raw.dir, list: ['node_modules', 'bower_components', 'jspm_packages', ...(raw.options.outDir ? [raw.options.outDir] : [])] }
        const files = raw.files?.list.map(f => slashed(join(raw.files!.dir, f)))
        const includes = raw.include ?? { dir: raw.dir, list: files ? [] : ['**/*'] }
        const inc = includes.list.map(p => globToRegExp(includes.dir, p))
        const exc = excluded.list.map(p => globToRegExp(excluded.dir, p))
        return f => files?.includes(f) || (inc.some(r => r.test(f)) && !exc.some(r => r.test(f)))
    }

    let nearest: string | null = null
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            if (!nearest && (await fs.read(`${dir}/${name}`).catch(() => null))?.kind === 'text')
                nearest = `${dir}/${name}`
        }
        if (nearest || isRoot(dir))
            break
    }
    const root = nearest ? await rawConfig(nearest) : null
    if (!nearest || !root)
        // Loose files: what an editor expects today, not what an old default would give.
        return { path: null, dir: fallbackDir, options: { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, allowJs: true }, covers: () => true }

    // A solution-style tsconfig only points at the real ones: the one that lists this file applies.
    const own = coverage(root)
    if (root.references.length && !own(file)) {
        for (const ref of root.references) {
            const target = join(root.dir, ref)
            const path = target.endsWith('.json') ? target : `${target}/tsconfig.json`
            const raw = await rawConfig(path)
            if (raw && coverage(raw)(file))
                return { path, dir: raw.dir, options: raw.options, covers: coverage(raw) }
        }
    }
    return { path: nearest, dir: root.dir, options: root.options, covers: own }
}

/** Options for lite-monaco's service: what changes the errors it shows, not where files are. */
export function checkOptions(options: TS.CompilerOptions): TS.CompilerOptions {
    const out: Record<string, unknown> = { ...options }
    for (const key of ['paths', 'pathsBasePath', 'baseUrl', 'rootDir', 'rootDirs', 'typeRoots', 'types', 'outDir', 'outFile', 'declarationDir', 'tsBuildInfoFile', 'configFilePath', 'project', 'composite', 'incremental', 'plugins', 'noLib', 'noEmit', 'allowJs', 'moduleResolution'])
        delete out[key]
    return out as TS.CompilerOptions
}

// ------------------------------------------------------------------------------------------- the project

interface Entry {
    exists: boolean
    text: string | null
}

interface Request {
    spec: string
    from: string
}

const NAMED = /\b(?:import|export)\b[^'"{};]*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g

/** The names each module is asked for with `import { a, b as c } from`. */
export function namedImports(text: string): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const m of text.matchAll(NAMED)) {
        const names = m[1].split(',').map(n => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean)
        out.set(m[3], [...out.get(m[3]) ?? [], ...names])
    }
    return out
}

/** A module the service cannot see into, as the importer sees it: a default and every name asked for, all `any`. */
function anyModule(names: Iterable<string>): string {
    const named = [...names].filter(n => /^[\w$]+$/.test(n) && n !== 'default')
    return `declare const m: any\nexport default m\n${named.map(n => `export declare const ${n}: any\n`).join('')}`
}

/** The type TypeScript gives a JSON value (as the type of the literal, widened): objects, arrays of one merged shape, primitives. */
function jsonType(value: unknown, depth = 0): string {
    if (value === null)
        return 'null'
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return typeof value
    if (depth > 12 || typeof value !== 'object')
        return 'any'
    if (Array.isArray(value)) {
        if (!value.length)
            return 'never[]'
        const objects = value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
        const parts = new Set(value.filter(v => !objects.includes(v as never)).map(v => jsonType(v, depth + 1)))
        if (objects.length) {
            // Elements that are objects become one shape: a key some lack is optional, as TypeScript normalises them.
            const keys = new Map<string, { types: Set<string>, count: number }>()
            for (const o of objects) {
                for (const [k, v] of Object.entries(o)) {
                    const at = keys.get(k) ?? { types: new Set<string>(), count: 0 }
                    at.types.add(jsonType(v, depth + 1))
                    at.count++
                    keys.set(k, at)
                }
            }
            parts.add(`{ ${[...keys].map(([k, at]) => `${JSON.stringify(k)}${at.count < objects.length ? '?' : ''}: ${[...at.types].join(' | ')}`).join('; ')} }`)
        }
        const one = [...parts]
        return one.length === 1 ? `${one[0].includes(' | ') ? `(${one[0]})` : one[0]}[]` : `(${one.join(' | ')})[]`
    }
    return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${jsonType(v, depth + 1)}`).join('; ')} }`
}

/** Largest JSON file given a type; a bigger one is `any` to the importer (the type would cost more than it tells). */
const MAX_JSON_TYPE = 1_000_000

/** A JSON file as a module: its default export (and each top-level key) with the type TypeScript gives it; null when it is not JSON or too big. */
function jsonModule(text: string): string | null {
    if (text.length > MAX_JSON_TYPE)
        return null
    let value: unknown
    try {
        value = JSON.parse(text)
    }
    catch {
        return null
    }
    const type = jsonType(value)
    if (type.length > MAX_JSON_TYPE)
        return null
    const named = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).filter(k => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default') : []
    return `declare const m: ${type}\nexport default m\n${named.map(k => `export declare const ${k}: (typeof m)["${k}"]\n`).join('')}`
}

/** A short stable tag for a path (names of the other versions of a package). */
function tag(text: string): string {
    let h = 0
    for (const c of text)
        h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0
    return h.toString(36)
}

/** One line re-exporting `target`, to file under a name the service resolves. */
function shimOf(shimDir: string, target: string, text: string): string {
    // `x.d.mts` next to `x.d.ts` (a package with both an ESM and a CJS build): the extensionless name would be the CJS one.
    return reexport(relative(shimDir, /\.[cm]ts$/.test(target) ? target : target.replace(/(?:\.d)?\.tsx?$/, '')), text)
}

function reexport(spec: string, text: string): string {
    if (/^\s*export\s*=/m.test(text))
        return `import m = require('${spec}')\nexport = m\n`
    const hasDefault = /\bexport\s+default\b|\bas\s+default\b|\bexport\s*(?:type\s*)?\{[^}]*\bdefault\b(?!\s+as\b)[^}]*\}/.test(text)
    return `export * from '${spec}'\n${hasDefault ? `export { default } from '${spec}'\n` : ''}`
}

export class Project {
    /** Everything handed to the service, by absolute path. */
    readonly files = new Map<string, string>()
    private readonly shims = new Map<string, string>()
    /** Where each shim leads, so a jump to "the module" lands on the real file. */
    private readonly shimTargets = new Map<string, string>()
    private readonly stubs = new Map<string, Set<string>>()
    /** The file a stand-in module stands for, by the stand-in's name in the service's table. */
    private readonly stubTargets = new Map<string, string>()
    /** JSON files imported (with `resolveJsonModule`): the module text typed from them, and the stubs that stand for each. */
    private readonly jsonModules = new Map<string, string | null>()
    private readonly jsonStubs = new Map<string, Set<string>>()
    /** File → the files it imports, for "who is affected by this change". */
    private readonly edges = new Map<string, Set<string>>()
    private readonly known = new Map<string, Entry>()
    private readonly reals = new Map<string, string>()
    private readonly reading = new Map<string, Promise<Entry>>()
    private readonly wanted = new Set<string>()
    private readonly wantedReal = new Set<string>()
    private readonly pendingShims = new Map<string, string>()
    private get rootFile() {
        return `${this.config.dir}/__root__.ts`
    }

    private readonly variants = new Map<string, Map<string, string>>()
    private readonly renames = new Map<string, Map<string, string>>()
    private readonly dottedCache = new Map<string, { from: string, to: string }>()
    private touched = false
    private bytes = 0
    private listing: Promise<string[]> | null = null
    private ambient: Promise<void> | null = null

    constructor(
        readonly ts: TsModule,
        private readonly fs: ProjectFs,
        readonly config: Config,
        private readonly limits: Limits = DEFAULT_LIMITS,
    ) {}

    // -- disk, as TypeScript's synchronous host sees it

    private entry(path: string): Promise<Entry> {
        let hit = this.reading.get(path)
        if (!hit) {
            hit = this.fs.read(path).then<Entry, Entry>(
                r => ({ exists: r.kind !== 'missing', text: r.kind === 'text' ? r.text : null }),
                () => ({ exists: false, text: null }),
            ).then((e) => {
                this.known.set(path, e)
                return e
            })
            this.reading.set(path, hit)
        }
        return hit
    }

    private lookup(path: string): Entry | undefined {
        const hit = this.known.get(path)
        if (hit)
            return hit
        this.touched = true
        this.wanted.add(path)
        return undefined
    }

    private readonly host = (): TS.ModuleResolutionHost => ({
        fileExists: p => this.lookup(slashed(p))?.exists ?? false,
        readFile: p => this.lookup(slashed(p))?.text ?? undefined,
        directoryExists: () => true,
        realpath: (p) => {
            const path = slashed(p)
            const hit = this.reals.get(path)
            if (hit !== undefined)
                return hit
            this.touched = true
            this.wantedReal.add(path)
            return path
        },
        getCurrentDirectory: () => this.config.dir,
        useCaseSensitiveFileNames: true,
    })

    private async fill() {
        const files = [...this.wanted]
        const reals = [...this.wantedReal]
        this.wanted.clear()
        this.wantedReal.clear()
        await Promise.all([
            ...files.map(f => this.entry(f)),
            ...reals.map(async p => this.reals.set(p, slashed(await this.fs.realPath(p).catch(() => p)))),
        ])
    }

    /** Runs `resolve` for every request until none of them touches a file that is not read yet. */
    private async settle<R, T>(requests: R[], resolve: (r: R, host: TS.ModuleResolutionHost) => T): Promise<Map<R, T | undefined>> {
        const results = new Map<R, T | undefined>()
        const host = this.host()
        let todo = requests
        for (let pass = 0; pass < 14 && todo.length; pass++) {
            const retry: R[] = []
            for (const r of todo) {
                this.touched = false
                let value: T | undefined
                try {
                    value = resolve(r, host)
                }
                catch {}
                if (this.touched)
                    retry.push(r)
                else
                    results.set(r, value)
            }
            todo = retry
            if (todo.length)
                await this.fill()
        }
        for (const r of todo)
            results.set(r, undefined)
        return results
    }

    // -- taking files in

    private accept(path: string, text: string): boolean {
        if (this.files.has(path))
            return false
        if (this.files.size >= this.limits.files || this.bytes + text.length > this.limits.bytes)
            return false
        this.bytes += text.length
        this.files.set(path, text)
        return true
    }

    private jsxRuntime(options: TS.CompilerOptions): string | null {
        const jsx = this.ts.JsxEmit
        return options.jsx === jsx.ReactJSX || options.jsx === jsx.ReactJSXDev ? `${options.jsxImportSource ?? 'react'}/jsx-runtime` : null
    }

    /** One thing at a time: the passes share what has been read and what is waiting to be. */
    private chain: Promise<unknown> = Promise.resolve()
    private serial<T>(run: () => Promise<T>): Promise<T> {
        const next = this.chain.then(run, run)
        this.chain = next.catch(() => {})
        return next
    }

    /** Takes the files in, and everything they import. `text` is what the editor holds for a file it has open. */
    add(roots: { path: string, text: string }[]): Promise<void> {
        return this.serial(() => this.addNow(roots))
    }

    private async addNow(roots: { path: string, text: string }[]): Promise<void> {
        const options = { ...this.config.options, noEmit: true }
        let queue: { path: string, text: string }[] = []
        for (const r of roots) {
            const had = this.files.get(r.path)
            if (had === undefined) {
                if (this.accept(r.path, r.text))
                    queue.push(r)
            }
            else if (had !== r.text) {
                this.bytes += r.text.length - had.length
                this.files.set(r.path, r.text)
                queue.push(r)
            }
        }
        const keyOf = (r: Request) => `${dirOf(r.from)}\0${r.spec}`
        while (queue.length) {
            const batch = queue
            queue = []
            const modules: Request[] = []
            const refs: Request[] = []
            const types: Request[] = []
            const named = new Map<string, Map<string, string[]>>()
            for (const file of batch) {
                const info = this.ts.preProcessFile(file.text, true, true)
                for (const i of info.importedFiles) {
                    modules.push({ spec: i.fileName, from: file.path })
                    // What the project itself gets for the same name, to tell a package's own copy from the project's.
                    if (isNodeModules(file.path) && !i.fileName.startsWith('.'))
                        modules.push({ spec: i.fileName, from: this.rootFile })
                }
                for (const r of info.referencedFiles)
                    refs.push({ spec: r.fileName, from: file.path })
                for (const t of info.typeReferenceDirectives)
                    types.push({ spec: t.fileName, from: file.path })
                const runtime = file.path.endsWith('x') ? this.jsxRuntime(options) : null
                if (runtime)
                    modules.push({ spec: runtime, from: file.path })
                named.set(file.path, namedImports(file.text))
                this.edges.set(file.path, new Set())
                this.renames.delete(file.path)
            }

            const unique = (list: Request[]) => [...new Map(list.map(r => [keyOf(r), r])).values()]
            const byKey = <T>(results: Map<Request, T | undefined>) => new Map([...results].map(([r, v]) => [keyOf(r), v]))
            const resolvedModules = byKey(await this.settle(unique(modules), (r, host) => this.ts.resolveModuleName(r.spec, r.from, options, host).resolvedModule))
            const resolvedTypes = byKey(await this.settle(unique(types), (r, host) => this.ts.resolveTypeReferenceDirective(r.spec, r.from, options, host).resolvedTypeReferenceDirective?.resolvedFileName))

            const found: string[] = []
            const link = (from: string, to: string) => {
                this.edges.get(from)?.add(to)
                found.push(to)
            }
            for (const r of refs)
                link(r.from, join(dirOf(r.from), r.spec))
            for (const r of types) {
                const to = resolvedTypes.get(keyOf(r))
                if (to)
                    link(r.from, slashed(to))
            }
            for (const r of modules) {
                const mod = resolvedModules.get(keyOf(r))
                const relativeSpec = r.spec === '.' || r.spec === '..' || r.spec.startsWith('./') || r.spec.startsWith('../')
                const asked = named.get(r.from)?.get(r.spec) ?? []
                const stubKey = relativeSpec ? `${slashed(join(dirOf(r.from), r.spec))}.d.ts` : `/node_modules/${r.spec}/index.d.ts`
                if (!mod) {
                    if (ASSET.test(r.spec)) {
                        this.stub(stubKey, asked)
                        if (relativeSpec)
                            this.stubTargets.set(vpath(stubKey), slashed(join(dirOf(r.from), r.spec.replace(/[?#].*$/, ''))))
                    }
                    continue
                }
                const target = slashed(mod.resolvedFileName)
                const typed = DECLARATION.test(target) || TS_SOURCE.test(target)
                const project = SOURCE.test(target) && !mod.isExternalLibraryImport
                if (!typed && !project) {
                    // JavaScript from a package, ...: the importer gets `any`; a JSON file, its own type.
                    this.stub(stubKey, asked)
                    this.stubTargets.set(vpath(stubKey), target)
                    if (/\.json$/i.test(target) && options.resolveJsonModule) {
                        if (!this.jsonModules.has(target))
                            this.jsonModules.set(target, jsonModule((await this.entry(target)).text ?? ''))
                        const stubs = this.jsonStubs.get(target) ?? new Set<string>()
                        stubs.add(stubKey)
                        this.jsonStubs.set(target, stubs)
                        link(r.from, target)
                    }
                    continue
                }
                if (!relativeSpec)
                    this.pendingShims.set(this.shimSpec(r.spec, target, r.from, resolvedModules.get(keyOf({ spec: r.spec, from: this.rootFile }))?.resolvedFileName), target)
                link(r.from, target)
            }

            const targets = [...new Set(found)].filter(t => !this.files.has(t) && SOURCE.test(t))
            const read = await Promise.all(targets.map(async t => [t, (await this.entry(t)).text] as const))
            for (const [path, text] of read) {
                if (text !== null && this.accept(path, text))
                    queue.push({ path, text })
            }
            await this.makeShims()
        }
    }

    /**
     * The name a package import is filed under for the service, which finds `x` only at /node_modules/x:
     * one place for the whole project. Two versions of `x` (a plugin's own copy of `vite`, a workspace package's own
     * `zod`) cannot both live there, so the others get a name of their own and the importing file is pointed at it
     * in `resolutions()`.
     */
    private shimSpec(spec: string, target: string, from: string, atRoot: string | undefined): string {
        const known = this.variants.get(spec) ?? new Map<string, string>()
        this.variants.set(spec, known)
        // The project's own resolution holds the plain name, whoever asks first.
        if (atRoot && !known.size)
            known.set(slashed(atRoot), spec)
        let name = known.get(target)
        if (!name) {
            name = known.size ? `${spec}/__v${tag(target)}` : spec
            known.set(target, name)
        }
        if (name !== spec) {
            const renames = this.renames.get(from) ?? new Map<string, string>()
            renames.set(spec, name)
            this.renames.set(from, renames)
        }
        return name
    }

    /** Where the imports that do not go to the plain name lead: importing file → what it writes → the shim it gets. */
    resolutions(): Record<string, Record<string, string>> {
        const out: Record<string, Record<string, string>> = {}
        for (const [from, renames] of this.renames) {
            const table: Record<string, string> = {}
            for (const [spec, name] of renames)
                table[spec] = vpath(`/node_modules/${name}/index.d.ts`)
            out[vpath(from)] = table
        }
        return out
    }

    private async makeShims() {
        for (const [spec, target] of this.pendingShims) {
            const text = this.files.get(target) ?? (await this.entry(target)).text ?? ''
            this.shims.set(`/node_modules/${spec}/index.d.ts`, shimOf(`/node_modules/${spec}`, target, text))
            this.shimTargets.set(`/node_modules/${spec}/index.d.ts`, target)
        }
        this.pendingShims.clear()
    }

    private stub(key: string, names: string[]) {
        const set = this.stubs.get(key) ?? new Set<string>()
        names.forEach(n => set.add(n))
        this.stubs.set(key, set)
    }

    // -- what a project brings besides the open file

    /** Global declarations: `@types/*` (or `types` from the tsconfig) and the project's own .d.ts files. */
    loadAmbient(): Promise<void> {
        this.ambient ??= this.serial(async () => {
            const options = this.config.options
            let names = options.types
            const roots = options.typeRoots?.map(slashed) ?? []
            if (!options.typeRoots) {
                for (let d = this.config.dir; ; d = dirOf(d)) {
                    roots.push(`${d}/node_modules/@types`)
                    if (isRoot(d))
                        break
                }
            }
            if (!names) {
                const lists = await Promise.all(roots.map(async r => (await this.fs.folders(r).catch(() => [])).filter(n => !n.startsWith('.'))))
                names = [...new Set(lists.flat())].slice(0, 150)
            }
            const entryFile = `${this.config.dir}/__ambient__.ts`
            const resolved = await this.settle(names, (name, host) => this.ts.resolveTypeReferenceDirective(name, entryFile, { ...options, typeRoots: roots }, host).resolvedTypeReferenceDirective?.resolvedFileName)
            const targets = [...resolved.values()].filter((t): t is string => !!t).map(slashed).filter(t => SOURCE.test(t))
            const read = await Promise.all(targets.map(async t => ({ path: t, text: (await this.entry(t)).text })))
            await this.addNow(read.filter((r): r is { path: string, text: string } => r.text !== null))
        })
        return this.ambient
    }

    /** Source files of the project the tsconfig covers (git's list, else a walk). */
    projectFiles(): Promise<string[]> {
        this.listing ??= this.fs.sources(this.config.dir).then(list => list.map(slashed).filter(f => !isNodeModules(f) && this.config.covers(f) && (this.config.options.allowJs || this.config.options.checkJs || !/\.[cm]?jsx?$/.test(f))), () => [])
        return this.listing
    }

    /** The list of files changed under us (a checkout, a new folder): takes the new ones in, lets go of the gone. */
    async reload(): Promise<void> {
        this.listing = null
        const listed = new Set(await this.projectFiles())
        await this.loadPaths([...listed].filter(f => !this.files.has(f)))
        for (const file of this.files.keys()) {
            if (!listed.has(file) && !isNodeModules(file) && file.startsWith(`${this.config.dir}/`) && SOURCE.test(file))
                this.drop(file)
        }
    }

    /** The project's own declaration files, which every file of it is checked with. */
    async loadDeclarations(): Promise<void> {
        const decls = (await this.projectFiles()).filter(f => DECLARATION.test(f))
        await this.loadPaths(decls)
    }

    /** Every file of the project (what a full check and project-wide rename need). */
    async loadAll(): Promise<void> {
        await this.loadPaths(await this.projectFiles())
    }

    private loadPaths(paths: string[]): Promise<void> {
        return this.serial(async () => {
            for (let i = 0; i < paths.length; i += 48) {
                const read = await Promise.all(paths.slice(i, i + 48).map(async path => ({ path, text: (await this.entry(path)).text })))
                await this.addNow(read.filter((r): r is { path: string, text: string } => r.text !== null))
            }
        })
    }

    // -- changes

    /** Reads a file again. True when the project's copy changed (or the file went away). */
    refresh(path: string): Promise<boolean> {
        return this.serial(() => this.refreshNow(path))
    }

    /** True for a JSON file some file imports, which `refresh` reads again too. */
    imported(path: string): boolean {
        return this.jsonModules.has(path)
    }

    private async refreshNow(path: string): Promise<boolean> {
        this.known.delete(path)
        this.reading.delete(path)
        const entry = await this.entry(path)
        if (this.jsonModules.has(path)) {
            const next = jsonModule(entry.text ?? '')
            const changed = next !== this.jsonModules.get(path)
            this.jsonModules.set(path, next)
            return changed
        }
        const had = this.files.get(path)
        if (entry.text === null) {
            if (had === undefined)
                return false
            this.drop(path)
            return true
        }
        if (had === entry.text)
            return false
        // New imports; a package.json or tsconfig that changed would need more, and reopening the file does that.
        await this.addNow([{ path, text: entry.text }])
        return true
    }

    drop(path: string) {
        const text = this.files.get(path)
        if (text === undefined)
            return
        this.bytes -= text.length
        this.files.delete(path)
        this.edges.delete(path)
    }

    /** What a write-back left on disk. */
    wrote(path: string, text: string) {
        const had = this.files.get(path)
        if (had !== undefined)
            this.bytes += text.length - had.length
        this.files.set(path, text)
        this.known.set(path, { exists: true, text })
        this.reading.delete(path)
    }

    /** The real file behind a name the service was given (a shim stands for a module; anything else is itself). */
    realOf(key: string): string {
        return this.shimTargets.get(key) ?? this.stubTargets.get(key) ?? key
    }

    /** Files that import `path`, directly. */
    importers(path: string): string[] {
        const out: string[] = []
        for (const [from, to] of this.edges) {
            if (to.has(path))
                out.push(from)
        }
        return out
    }

    /** The project's own files (not packages) among those loaded. */
    own(): string[] {
        return [...this.files.keys()].filter(f => !isNodeModules(f) && (f.startsWith(`${this.config.dir}/`) || this.config.covers(f)))
    }

    /** The table for `setTsFiles`: real files by path, plus the files that stand for non-relative imports. */
    /** `from '.'` and `from '..'` in a package's declarations, as `./index` and `../index`: the service resolves only names that start with `./` or `../`. */
    private dotted(path: string, text: string): string {
        const had = this.dottedCache.get(path)
        if (had?.from === text)
            return had.to
        const to = text.replace(/(\b(?:from|import|require)\s*\(?)(['"])(\.\.?)\2/g, '$1$2$3/index$2')
        this.dottedCache.set(path, { from: text, to })
        return to
    }

    output(): Record<string, string> {
        const out: Record<string, string> = {}
        for (const [k, v] of this.shims)
            out[k] = v
        const jsonOf = (stub: string) => {
            for (const [json, stubs] of this.jsonStubs) {
                if (stubs.has(stub))
                    return this.jsonModules.get(json) ?? null
            }
            return null
        }
        for (const [k, names] of this.stubs)
            out[vpath(k)] = jsonOf(k) ?? anyModule(names)
        for (const [k, v] of this.files)
            out[vpath(k)] = isNodeModules(k) ? this.dotted(k, v) : v
        // The service looks for `./x.mjs` as x.ts / x.d.ts only: ESM-only files (x.mts, x.d.mts) also go under those names, where free.
        for (const [k, v] of this.files) {
            const alias = k.replace(/\.d\.[cm]ts$/, '.d.ts').replace(/(?<!\.d)\.[cm]ts$/, '.ts')
            if (alias !== k && !this.files.has(alias) && !(vpath(alias) in out))
                out[vpath(alias)] = v
        }
        // Declaration files of packages import each other as `./x.ts` (TypeScript maps that to x.d.ts; the service does not): a name that leads there.
        for (const [k, v] of this.files) {
            const m = /^(.*)\.d\.([cm]?)ts$/.exec(k)
            if (!m || !isNodeModules(k))
                continue
            const alias = `${m[1]}.${m[2]}ts`
            if (!this.files.has(alias) && !(vpath(alias) in out))
                out[vpath(alias)] = reexport(`./${k.slice(k.lastIndexOf('/') + 1)}`, v)
        }
        return out
    }
}
