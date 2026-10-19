// The `<script>` of a Vue component or an HTML page, read by the TypeScript service as a file of its own
// (`X.vue.ts`, `X.html.js`: same offsets as the markup file, everything else blank). Completion, hover and
// definitions are asked of that service; squiggles come from the project's checker (codeIntel).
import type { CompletionItemM } from 'lite-monaco'
import type { Family, Where } from '@/store/codeIntel'
import { getTSService } from 'lite-monaco'
import { codeIntel } from '@/store/codeIntel'
import { vpath } from '../tsProject'

export interface Embedded extends Where {
    family: Family
    /** The markup file's text → what the service reads in its place. */
    code: (text: string) => string
}

/** TypeScript `ScriptElementKind` → Monaco's CompletionItemKind. */
const KIND: Record<string, number> = {
    'method': 0, 'function': 1, 'local function': 1, 'constructor': 2, 'construct': 2, 'property': 9, 'getter': 9, 'setter': 9,
    'var': 4, 'let': 4, 'const': 14, 'local var': 4, 'parameter': 4, 'class': 5, 'local class': 5, 'interface': 7, 'type': 7,
    'enum': 15, 'enum member': 16, 'module': 8, 'alias': 8, 'keyword': 17, 'string': 18, 'warning': 20, 'directory': 23, 'script': 20,
}

function service(at: Embedded, text: string) {
    const session = getTSService({ lang: at.family, fileName: at.path })
    session.update(at.code(text))
    return { session, svc: session.service() }
}

export function tsComplete(at: Embedded, text: string, offset: number): CompletionItemM[] {
    const { svc } = service(at, text)
    if (!svc)
        return []
    try {
        const info = svc.getCompletionsAtPosition(vpath(at.path), offset, { includeCompletionsWithInsertText: true, includeCompletionsForModuleExports: false })
        return (info?.entries ?? []).map((e): CompletionItemM => ({
            label: e.name,
            kind: KIND[e.kind] ?? 9,
            detail: e.kind,
            sortText: e.sortText,
            insertText: e.insertText ?? e.name,
            tags: e.kindModifiers?.includes('deprecated') ? [1] : undefined,
        }))
    }
    catch {
        return []
    }
}

export function tsHover(at: Embedded, text: string, offset: number): { from: number, to: number, markdown: string } | null {
    const { session, svc } = service(at, text)
    const ts = session.ts()
    if (!svc || !ts)
        return null
    try {
        const info = svc.getQuickInfoAtPosition(vpath(at.path), offset)
        if (!info)
            return null
        const docs = ts.displayPartsToString(info.documentation)
        const tags = (info.tags ?? []).map(t => `*@${t.name}* ${ts.displayPartsToString(t.text)}`).join('\n\n')
        const markdown = ['```ts', ts.displayPartsToString(info.displayParts), '```', docs, tags].filter(Boolean).join('\n')
        return { from: info.textSpan.start, to: info.textSpan.start + info.textSpan.length, markdown }
    }
    catch {
        return null
    }
}

/** Where a name is declared at the top of the script (a setup binding, an import): the template's names. */
export function tsDeclaration(at: Embedded, text: string, name: string): number | null {
    const { svc } = service(at, text)
    if (!svc)
        return null
    try {
        const tree = svc.getNavigationTree(vpath(at.path))
        const find = (items: readonly import('typescript').NavigationTree[], depth: number): number | null => {
            for (const item of items) {
                if (item.text === name && item.nameSpan)
                    return item.nameSpan.start
                // An import is a child of nothing but the file; `export default { data() {…} }` holds more, one level down.
                const inner = depth < 2 ? find(item.childItems ?? [], depth + 1) : null
                if (inner !== null)
                    return inner
            }
            return null
        }
        return find(tree.childItems ?? [], 0)
    }
    catch {
        return null
    }
}

/** Go to definition for `offset`, anywhere (the same file too); the path is the markup file's when it is here. */
export function tsDefinition(at: Embedded, markup: string, text: string, offset: number) {
    return codeIntel.definitionElsewhere(at, at.family, at.code(text), offset, { same: markup })
}

export function tsSpan(at: Embedded, text: string, offset: number) {
    return codeIntel.definitionSpan(at, at.family, at.code(text), offset)
}
