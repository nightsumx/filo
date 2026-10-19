// A Vue single-file component as the TypeScript service can read it: the `<script>` blocks stay where they are
// (every other character, the template and styles included, becomes a space; line breaks stay), so an offset in the
// component is the same offset in the TypeScript text. No dependencies: the project reader uses it too.

export interface Block {
    tag: 'script' | 'style'
    attrs: string
    /** The block's content, as offsets of the component's text. */
    from: number
    to: number
    lang: string | null
    setup: boolean
    scoped: boolean
    /** `<script src="…">` / `<style src="…">`: the content lives in another file. */
    src: string | null
}

const OPEN = /<(script|style)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi
const COMMENT = /<!--[\s\S]*?-->/g

function attr(attrs: string, name: string): string | null | undefined {
    const m = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?(?=\\s|$)`, 'i').exec(attrs)
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : undefined
}

/** The `<script>` and `<style>` blocks of the component, in order. */
export function blocks(text: string): Block[] {
    const comments: [number, number][] = []
    for (const c of text.matchAll(COMMENT))
        comments.push([c.index, c.index + c[0].length])
    const inComment = (i: number) => comments.some(([a, b]) => i >= a && i < b)
    const out: Block[] = []
    OPEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = OPEN.exec(text))) {
        if (inComment(m.index))
            continue
        const tag = m[1].toLowerCase() as 'script' | 'style'
        const from = m.index + m[0].length
        if (m[0].endsWith('/>')) {
            OPEN.lastIndex = from
            continue
        }
        const close = text.toLowerCase().indexOf(`</${tag}`, from)
        const to = close < 0 ? text.length : close
        const attrs = m[2]
        out.push({
            tag,
            attrs,
            from,
            to,
            lang: attr(attrs, 'lang') ?? null,
            setup: attr(attrs, 'setup') !== undefined,
            scoped: attr(attrs, 'scoped') !== undefined,
            src: attr(attrs, 'src') ?? null,
        })
        OPEN.lastIndex = to
    }
    return out
}

/** `text` with everything outside `keep` blanked (line breaks stay). */
export function blank(text: string, keep: readonly { from: number, to: number }[]): string {
    let out = ''
    let at = 0
    for (const k of [...keep].sort((a, b) => a.from - b.from)) {
        out += text.slice(at, k.from).replace(/[^\n\r]/g, ' ') + text.slice(k.from, k.to)
        at = k.to
    }
    return out + text.slice(at).replace(/[^\n\r]/g, ' ')
}

/**
 * The compiler macros of `<script setup>`, as functions of the file itself: the macros are not imported, and a file's
 * own declaration wins over a global one (so a project that also pulls in vue's macro types sees no clash).
 */
const MACROS = `
declare function defineProps<T = any>(props?: any): Readonly<T>;
declare function defineEmits<T = any>(emits?: any): T extends (...a: any[]) => any ? T : (...a: any[]) => void;
declare function defineExpose(exposed?: Record<string, any>): void;
declare function defineOptions(options: Record<string, any>): void;
declare function defineSlots<T = any>(): T;
declare function defineModel<T = any>(...a: any[]): any;
declare function withDefaults<T, D>(props: T, defaults: D): T;
`

export interface VueScript {
    /** What the TypeScript service reads in place of the component. */
    code: string
    /** The script is TypeScript (`lang="ts"`); a plain JavaScript script is read for types but not reported on. */
    ts: boolean
    /** Where the script blocks are, in the component's text (and so in `code`). */
    ranges: { from: number, to: number }[]
}

export function vueScript(text: string): VueScript {
    const scripts = blocks(text).filter(b => b.tag === 'script' && !b.src)
    const ranges = scripts.map(b => ({ from: b.from, to: b.to }))
    const setup = scripts.some(b => b.setup)
    const plain = scripts.filter(b => !b.setup)
    const hasDefault = plain.some(b => /\bexport\s+default\b/.test(text.slice(b.from, b.to)))
    const ts = scripts.length === 0 || scripts.some(b => /^tsx?$/i.test(b.lang ?? ''))
    let code = `${blank(text, ranges)}\n${TAIL}${ts ? 'ts' : 'js'}\n`
    // Past the end of the text: nothing shifts. Importers get a component to use.
    if (setup)
        code += MACROS
    if (!hasDefault)
        code += `export default {} as import('vue').DefineComponent<{}, {}, any>;\n`
    return { code, ts, ranges }
}

const TAIL = '//#vue-tail:'

/** Where the component's own text ends in the TypeScript text (what follows is ours), and whether its script is TypeScript. Null for any other file. */
export function vueTail(code: string): { end: number, ts: boolean } | null {
    const at = code.lastIndexOf(`\n${TAIL}`)
    return at < 0 ? null : { end: at, ts: code.startsWith('ts', at + 1 + TAIL.length) }
}

/** `X.vue.ts` is how the service sees `X.vue` (TypeScript finds `./X.vue` by adding `.ts`). */
export const VUE_VIRTUAL = /\.vue\.ts$/
export const virtualOf = (vue: string) => `${vue}.ts`
export const realOfVirtual = (path: string) => path.replace(VUE_VIRTUAL, '.vue')

/**
 * The component with the changes made to its TypeScript text (`was` → `now`, say by a rename) put back into its
 * script. Null when that cannot be told: more than one script block, or a change outside the script.
 */
export function intoComponent(text: string, was: string, now: string): string | null {
    const ranges = vueScript(text).ranges
    const tail = vueTail(now)
    if (ranges.length !== 1 || !tail || vueScript(text).code !== was)
        return null
    const [{ from, to }] = ranges
    const after = text.length - to
    if (now.slice(0, from) !== was.slice(0, from) || now.slice(tail.end - after, tail.end) !== was.slice(to, text.length))
        return null
    return text.slice(0, from) + now.slice(from, tail.end - after) + text.slice(to)
}
