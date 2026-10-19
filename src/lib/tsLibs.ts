// TypeScript's lib.*.d.ts go into the bundle as lazy chunks: completions and hover work offline,
// and the editor never reaches out to jsdelivr. A failed load throws, which keeps lite-monaco from
// falling back to the CDN. Both the window and the checking worker (src/workers/tsCheck.worker.ts) install it.
import { setTsLibLoader } from 'lite-monaco'

const tsLibs = import.meta.glob<string>('/node_modules/typescript/lib/lib.*.d.ts', { query: '?raw', import: 'default' })

export function installTsLibs() {
    setTsLibLoader(async () => {
        const entries = await Promise.all(Object.entries(tsLibs).map(async ([path, load]) => [path.slice(path.lastIndexOf('/') + 1), await load()] as const))
        if (!entries.length)
            throw new Error('TypeScript libs are not bundled')
        return new Map(entries)
    })
}
