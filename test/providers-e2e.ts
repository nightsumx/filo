// End-to-end check of Settings → 模型供应商 in the built app, with real pi, an empty agent dir and a
// scripted model (no tokens spent):
//   - with no provider, the composer says so and links to the page
//   - an API-key sign-in runs through pi's own prompt and lands in auth.json
//   - a custom endpoint is added through the form (model list fetched from the endpoint), the idle
//     thread restarts pi, picks up the model, and a prompt goes through it
//   - sign out and endpoint removal leave the files as they were
//
//   bun run build && bun run e2e:providers
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows } from './app'
import { startMockLlm } from './harness'

const WORK = '/private/tmp/pi-gui-providers'
const SHOTS = process.env.SHOTS ?? ''

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

    const llm = await startMockLlm(() => ({ text: 'hello from mock' }))
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
    // Ambient keys would give pi a model before the test configures one.
    const env: Record<string, string> = { PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' }
    for (const key of Object.keys(process.env)) {
        if (key.endsWith('_API_KEY') || key.endsWith('_TOKEN') || key.startsWith('AWS_'))
            env[key] = ''
    }

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const js = (code: string) => page.evaluate<any>(code)
        const clickButton = (text: string, scope = 'document') => js(`(() => { const b = [...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
        // React tracks the value through the native setter; typing would do the same.
        const fill = (selector: string, value: string) => js(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)})
            if (!el) return false
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return true
        })()`)
        const row = (name: string) => `[...document.querySelectorAll('[role="dialog"] .py-2')].find(r => r.querySelector('.truncate')?.textContent === ${JSON.stringify(name)})`

        // ---------------------------------------------------------------- no model yet
        await until('thread ready', () => js(`window.__app.active?.agentStatus === 'ready'`), 30_000)
        check(await js('window.__app.active.models.length') === 0, 'pi starts with no usable model')
        await until('no-model notice', () => js(`!!document.querySelector('[role="status"]')?.textContent.includes('pi has no model to use yet')`))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'no-model.png'))
        check(await clickButton('Set up a provider'), 'the notice offers the provider page')
        await until('providers page', () => js(`!!document.querySelector('[role="dialog"] section[aria-label="Model providers"]') && !!(${row('DeepSeek')})`), 15_000)
        check(await js(`window.__app.settingsPage`) === 'providers', 'Settings opens on Model providers')

        // ---------------------------------------------------------------- API key through pi's prompt
        check(await clickButton('Enter API key', row('DeepSeek')), 'DeepSeek offers an API key')
        await until('key prompt', () => js(`!!document.querySelector('[role="dialog"] input[type="password"]')`))
        await fill('[role="dialog"] input[type="password"]', 'sk-e2e')
        if (SHOTS) {
            await js(`document.querySelector('[role="dialog"] input[type="password"]').scrollIntoView({ block: 'center' })`)
            await page.screenshot(path.join(SHOTS, 'key-prompt.png'))
        }
        check(await clickButton('OK', row('DeepSeek')), 'the key is submitted')
        await until('DeepSeek configured', () => js(`!!${row('DeepSeek')}?.textContent.includes('API key saved')`), 15_000)
        const auth = JSON.parse(await readFile(path.join(agentDir, 'auth.json'), 'utf8'))
        check(auth.deepseek?.key === 'sk-e2e' && auth.deepseek?.type === 'api_key', 'the key is saved to pi\'s auth.json')
        // The restarted thread now lists DeepSeek's models; sign out again so the endpoint is the only provider.
        await until('DeepSeek models in the thread', () => js(`window.__app.active.agentStatus === 'ready' && window.__app.active.models.some(m => m.provider === 'deepseek')`), 30_000)
        check(true, 'the idle thread restarted pi and sees the new provider')
        await js(`window.pi.providerLogout('deepseek')`)
        await until('DeepSeek signed out', () => js(`!!${row('DeepSeek')} && !${row('DeepSeek')}.textContent.includes('API key saved')`), 15_000)
        check(!JSON.parse(await readFile(path.join(agentDir, 'auth.json'), 'utf8')).deepseek, 'sign out removes it from auth.json')

        // ---------------------------------------------------------------- custom endpoint through the form
        await until('thread back to no models', () => js(`window.__app.active.agentStatus === 'ready' && window.__app.active.models.length === 0`), 30_000)
        check(await clickButton('Custom endpoint'), 'the custom endpoint form opens')
        await until('endpoint form', () => js(`!!document.querySelector('[role="dialog"] form[aria-labelledby]')`))
        await fill('[role="dialog"] form input[placeholder="e.g. Company gateway"]', 'Mock LLM')
        check(await js(`document.querySelector('[role="dialog"] form input[placeholder="my-gateway"]').value`) === 'mock-llm', 'the ID follows the name')
        await fill('[role="dialog"] form input[placeholder="https://example.com/v1"]', llm.baseUrl)
        await js(`document.querySelector('[role="dialog"] form [role="switch"]').click()`)
        check(await clickButton('Fetch from the endpoint'), 'models can be fetched')
        await until('fetched model', () => js(`[...document.querySelectorAll('[role="dialog"] form input[aria-label="Model ID"]')].some(i => i.value === 'mock-1')`), 10_000)
        if (SHOTS) {
            await js(`document.querySelector('[role="dialog"] form[aria-labelledby]').scrollIntoView({ block: 'center' })`)
            await page.screenshot(path.join(SHOTS, 'endpoint-form.png'))
        }
        check(await clickButton('Save'), 'the endpoint is saved')
        await until('Mock LLM listed', () => js(`!!${row('Mock LLM')}?.textContent.includes('No key needed · 1 model available')`), 15_000)
        const models = JSON.parse(await readFile(path.join(agentDir, 'models.json'), 'utf8'))
        const entry = models.providers?.['mock-llm']
        check(Object.keys(models.providers).length === 1 && entry.name === 'Mock LLM' && entry.baseUrl === llm.baseUrl && entry.api === 'openai-completions' && entry.apiKey === 'none' && JSON.stringify(entry.models) === '[{"id":"mock-1"}]', 'models.json holds just the new endpoint')
        if (SHOTS) {
            await js(`document.querySelector('[role="dialog"] section[aria-label="Model providers"]').scrollIntoView()`)
            await page.screenshot(path.join(SHOTS, 'providers.png'))
        }

        await until('thread has the endpoint model', () => js(`window.__app.active.agentStatus === 'ready' && window.__app.active.models.some(m => m.provider === 'mock-llm')`), 30_000)
        check(!(await js(`!!document.querySelector('[role="status"]')?.textContent.includes('pi has no model to use yet')`)), 'the no-model notice is gone')
        await js(`window.__app.setSettingsOpen(false)`)
        await until('model chosen', () => js(`window.__app.active.state?.model?.provider === 'mock-llm'`), 10_000)
        await js(`(() => { const t = window.__app.active; t.draft = 'hi'; void t.send(); return true })()`)
        await until('reply from the endpoint', () => js(`!window.__app.active.running && JSON.stringify([...window.__app.active.items, ...window.__app.active.live]).includes('hello from mock')`), 30_000)
        check(llm.requests.length > 0, 'the prompt went to the custom endpoint')

        // ---------------------------------------------------------------- removal
        await js(`window.pi.removeEndpoint('mock-llm')`)
        check(JSON.stringify(JSON.parse(await readFile(path.join(agentDir, 'models.json'), 'utf8'))) === '{}', 'removing the endpoint empties models.json')
        check(!existsSync(path.join(agentDir, 'settings.json')) || !(await readFile(path.join(agentDir, 'settings.json'), 'utf8')).includes('sk-'), 'no key leaks into settings.json')
    }
    finally {
        await stop()
        await llm.close()
    }
    await rm(WORK, { recursive: true, force: true })
    console.log('providers e2e passed')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
