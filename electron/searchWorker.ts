// Worker thread for session search (see search.ts): indexing reads every session file, which would
// stall the main process and with it every window's agent traffic.
import { parentPort, workerData } from 'node:worker_threads'
import { SessionSearch } from './search'

const search = new SessionSearch(workerData?.cacheFile)

parentPort?.on('message', async ({ id, query }: { id: number, query: string }) => {
    try {
        parentPort!.postMessage({ id, ok: true, results: await search.search(query) })
    }
    catch (error: any) {
        parentPort!.postMessage({ id, ok: false, error: String(error?.message ?? error) })
    }
})
