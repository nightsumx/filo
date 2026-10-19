// The type checker, in a worker: the window sends the project's files and asks for diagnostics, and its own
// thread never waits for a type check. The calls are TsCheckApi's (src/lib/tsCheck.ts); a call with an `id`
// is answered, the others are not.
import { installTsLibs } from '@/lib/tsLibs'
import { TsChecker } from '@/lib/tsCheck'

interface Scope {
    onmessage: ((e: MessageEvent<{ id?: number, method: keyof TsChecker, args: unknown[] }>) => void) | null
    postMessage: (message: unknown) => void
}
const scope = globalThis as unknown as Scope

installTsLibs()
const checker = new TsChecker()

scope.onmessage = async ({ data: { id, method, args } }) => {
    try {
        const result = await Reflect.apply(checker[method], checker, args)
        if (id !== undefined)
            scope.postMessage({ id, result })
    }
    catch (error) {
        if (id !== undefined)
            scope.postMessage({ id, error: String(error) })
    }
}
scope.postMessage({ ready: true })
