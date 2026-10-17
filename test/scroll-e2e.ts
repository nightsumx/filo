// End-to-end check of the transcript's bottom-following while a reply streams, in the built app with
// real pi and a scripted model:
//   - output streaming in keeps the view at the bottom
//   - small wheel ticks up (a trackpad) let go of the bottom, and new output doesn't pull the view back
//   - scrolling back down to the bottom follows again
//
//   bun run build && bun run e2e:scroll
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'
import { startMockLlm } from './harness'

const WORK = workDir('pi-gui-scroll')
const LINES = 160
const STREAM_MS = 40

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))

    const reply = Array.from({ length: LINES }, (_, i) => `Line ${i + 1} of a long streamed answer.\n\n`).join('')
    const llm = await startMockLlm(() => ({ text: reply, streamMs: STREAM_MS }))
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: { mock: { baseUrl: llm.baseUrl, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock-1', contextWindow: 100_000, maxTokens: 1000 }] } },
    }))
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', defaultThinkingLevel: 'off' }))
    await writeFile(path.join(userData, 'state.json'), JSON.stringify({
        projects: [repo],
        hiddenProjects: [],
        tabs: {},
        activeTabs: {},
        layout: 'single',
        theme: 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: [],
        windows: [{ projects: [repo] }],
    }))

    const stop = await launch({ PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' })
    try {
        const [{ page }] = await windows(1)
        await page.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false })
        const key = await page.evaluate<string>('window.__app.active.key')
        await page.evaluate(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); t.draft = 'stream please'; void t.send(); return true })()`)
        const S = `document.querySelector('[data-transcript]')`
        const metrics = () => page.evaluate<{ top: number, distance: number, height: number, running: boolean }>(`(() => { const s = ${S}; return { top: s.scrollTop, distance: s.scrollHeight - s.scrollTop - s.clientHeight, height: s.scrollHeight, running: window.__app.active.running } })()`)
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

        // Enough output to overflow the viewport a few times over.
        await until('transcript overflows', async () => {
            const m = await metrics()
            return m.height > 2000 && m.running
        }, 30_000)
        let m = await metrics()
        check(m.distance < 2, `streaming output keeps the view at the bottom (${Math.round(m.distance)}px off)`)

        // Trackpad-sized ticks, each well under the old 80px "near the bottom" threshold.
        const box = await page.evaluate<{ x: number, y: number }>(`(() => { const r = ${S}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
        for (let i = 0; i < 6; i++) {
            await page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -20 })
            await sleep(30)
        }
        const after = await metrics()
        await sleep(STREAM_MS * 15)
        m = await metrics()
        check(after.distance > 40 && m.running, `small wheel ticks up let go of the bottom (${Math.round(after.distance)}px up)`)
        check(Math.abs(m.top - after.top) < 2 && m.height > after.height, `new output doesn't pull the view back down (top ${Math.round(after.top)} → ${Math.round(m.top)})`)

        // Scrolling back down to just short of the bottom does not snap to it.
        await page.evaluate(`(() => { const s = ${S}; s.scrollTop = s.scrollHeight - s.clientHeight - 40; return true })()`)
        await sleep(STREAM_MS * 15)
        const near = await metrics()
        check(near.distance > 30, `scrolling down to near the bottom doesn't force it (${Math.round(near.distance)}px off)`)

        // Back down to the bottom: following resumes.
        await page.evaluate(`(() => { const s = ${S}; s.scrollTop = s.scrollHeight; return true })()`)
        await sleep(STREAM_MS * 15)
        m = await metrics()
        check(m.distance < 2 && m.running, `scrolling back to the bottom follows the output again (${Math.round(m.distance)}px off)`)
    }
    finally {
        await stop()
        await llm.close()
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
