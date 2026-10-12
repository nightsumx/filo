// Settings → 供应商 → 测试渠道, main side. The script and its judgement are pi-capabilities'
// (lib/channelTest.ts, the same as pi-cc-tui's /channel-test); each request goes through the provider
// helper, so it is sent by the user's own pi. Results are saved to pi's agent dir for both hosts.
// A run belongs to main, not to the page: it goes on when Settings closes (the idle step waits
// minutes) and its updates go to every window.
import type { ChannelHealth, ChannelModel, ChannelRun, ChannelTestUpdate } from '@shared/providers'
import type { HistoryCache } from 'pi-capabilities/lib/channelStore.ts'
import type { ProbeReply, ProbeRequest } from 'pi-capabilities/lib/channelTest.ts'
import { channelHistory, readChannelResults, saveChannelResult } from 'pi-capabilities/lib/channelStore.ts'
import { runChannelTest } from 'pi-capabilities/lib/channelTest.ts'

export interface ChannelHelper {
    probeModels: (provider: string) => Promise<ChannelModel[]>
    probe: (provider: string, model: string, request: ProbeRequest, signal?: AbortSignal) => Promise<ProbeReply>
}

export class ChannelTests {
    private runs = new Map<string, { run: ChannelRun, controller: AbortController }>()
    private seq = 0
    private historyCache: HistoryCache = new Map()
    /** One scan at a time: a second caller waits for the same one. */
    private scanning: Promise<ChannelHealth['history']> | null = null

    constructor(private options: {
        helper: ChannelHelper
        agentDir: () => string
        sessionsDir: () => Promise<string>
        broadcast: (update: ChannelTestUpdate) => void
    }) {}

    models(provider: string): Promise<ChannelModel[]> {
        return this.options.helper.probeModels(provider)
    }

    async health(): Promise<ChannelHealth> {
        this.scanning ??= this.options.sessionsDir()
            .then(root => channelHistory(root, { cache: this.historyCache }))
            .finally(() => {
                this.scanning = null
            })
        const [results, history] = await Promise.all([readChannelResults(this.options.agentDir()), this.scanning])
        return { results, history, running: [...this.runs.values()].map(r => r.run) }
    }

    /**
     * Starts a run and returns its id; progress and the outcome are broadcast. The model and its
     * prices are looked up in pi again, not taken from the window. One run per model at a time.
     */
    async start(provider: string, modelId: string, idleMs?: number): Promise<string> {
        const running = [...this.runs.values()].find(r => r.run.provider === provider && r.run.model === modelId)
        if (running)
            return running.run.test
        const model = (await this.models(provider)).find(m => m.id === modelId)
        if (!model)
            throw new Error(`${provider}/${modelId} is not available in pi`)
        const run: ChannelRun = { test: `channel-${++this.seq}`, provider, model: modelId }
        const controller = new AbortController()
        this.runs.set(run.test, { run, controller })
        const { broadcast, helper } = this.options
        // After the caller has the id, so its first update is not ahead of it.
        setImmediate(() => void runChannelTest({
            model: { provider, id: model.id, name: model.name, cost: model.cost },
            idleMs,
            signal: controller.signal,
            send: (request, signal) => helper.probe(provider, model.id, request, signal),
            onProgress: (progress) => {
                run.progress = progress
                broadcast({ ...run, progress })
            },
        }).then(
            async (result) => {
                await saveChannelResult(this.options.agentDir(), result).catch(() => {})
                this.runs.delete(run.test)
                broadcast({ test: run.test, provider, model: modelId, result })
            },
            (error: Error) => {
                this.runs.delete(run.test)
                broadcast({ test: run.test, provider, model: modelId, error: error.message, cancelled: error.name === 'AbortError' || undefined })
            },
        ))
        return run.test
    }

    cancel(test: string) {
        this.runs.get(test)?.controller.abort()
    }

    cancelAll() {
        for (const { controller } of this.runs.values())
            controller.abort()
    }
}
