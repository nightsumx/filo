// End-to-end check of the review, search, fork, terminal-presence and tab-moving features in the
// built app, with real pi and a scripted model (no tokens spent):
//   - the changes panel knows which thread edited what, and flags files two threads both changed
//   - commit / roll back from the panel's IPC
//   - previews: changed images show both versions, PDF in a frame, Markdown / CSV / HTML / notebooks
//     rendered, fonts as samples, archives as entry lists, documents as QuickLook thumbnails
//   - ⌘⇧F search finds a prompt and opens its thread
//   - fork a prompt into a new tab, and ask again from a prompt in place
//   - a terminal pi's presence file shows up in the project tree
//   - a tab torn off into its own window keeps its live pi process, survives a restart in that
//     window, and can be dragged back
//
//   bun run build && bun run e2e:features
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, COMMAND, launch, PORT, until, windows } from './app'
import { startMockLlm } from './harness'

const WORK = '/private/tmp/pi-gui-features'
const SHOTS = process.env.SHOTS ?? ''

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A one-page PDF with a line of text and a valid xref table. */
function tinyPdf(): string {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        '<< /Length 39 >>\nstream\nBT /F1 18 Tf 20 60 Td (Hello PDF) Tj ET\nendstream',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    let out = '%PDF-1.4\n'
    const offsets = objects.map((body, i) => {
        const at = out.length
        out += `${i + 1} 0 obj\n${body}\nendobj\n`
        return at
    })
    const xref = out.length
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return out
}

async function main() {
    await rm(WORK, { recursive: true, force: true })
    const repo = path.join(WORK, 'repo')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    await Promise.all([repo, userData, agentDir].map(d => mkdir(d, { recursive: true })))
    await writeFile(path.join(repo, 'a.txt'), 'original\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
    git(repo, 'config', 'user.name', 't')
    git(repo, 'config', 'user.email', 't@t')

    // "edit <tag>" writes a.txt and src/<tag>.ts, then answers; anything else gets an echo.
    const llm = await startMockLlm((request) => {
        const last = request.messages.at(-1)
        if (last?.role === 'tool')
            return { text: 'done editing' }
        const prompt = String(typeof last?.content === 'string' ? last.content : last?.content?.map((p: any) => p.text).join('') ?? '')
        const edit = /^edit (\w+)/.exec(prompt)
        if (edit) {
            return { toolCalls: [
                { name: 'write', arguments: { path: 'a.txt', content: `changed by ${edit[1]}\n` } },
                { name: 'write', arguments: { path: `src/${edit[1]}.ts`, content: `export const ${edit[1]} = 1\n` } },
            ] }
        }
        return { text: `echo: ${prompt}` }
    })
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
        theme: process.env.E2E_THEME ?? 'dark',
        lang: 'en',
        transcriptLang: 'en',
        capabilities: [],
        windows: [{ projects: [repo] }],
    }))
    const env = { PI_GUI_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_GUI_TEST: '1' }
    const R = JSON.stringify(repo)
    const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' })
    let movedSession = ''

    let stop = await launch(env)
    try {
        let wins = await windows(1)
        let page = wins[0].page
        const send = async (key: string, text: string) => {
            await page.evaluate(`(() => { const t = window.__app.threads.get(${JSON.stringify(key)}); t.draft = ${JSON.stringify(text)}; void t.send(); return true })()`)
        }
        const settled = (expr: string) => until(`${expr} settled`, () => page.evaluate<boolean>(`(() => { const t = ${expr}; return !!t && !t.running && t.persisted && t.key === t.sessionPath })()`), 30_000)

        // ---------------------------------------------------------------- review: who edited what
        const t1 = await page.evaluate<string>('window.__app.active.key')
        await send(t1, 'edit one')
        await settled('window.__app.active')
        const s1 = await page.evaluate<string>('window.__app.active.sessionPath')
        movedSession = s1
        await page.evaluate(`window.__app.refreshEdits(${R})`)
        const edits = await until('edit log', () => page.evaluate<Record<string, { session: string }[]> | null>(`(() => { const e = window.__app.edits.get(${R}); return e && e['a.txt'] ? JSON.parse(JSON.stringify(e)) : null })()`))
        check(edits['a.txt']?.[0]?.session === s1 && edits['src/one.ts']?.[0]?.session === s1, 'the edit log ties both files to the thread that wrote them')
        check(!(await page.evaluate<boolean>(`document.querySelector('[role="tab"] [role="img"][aria-label^="Shares changed files"]') !== null`)), 'no conflict mark with one thread')

        // A second thread writes a.txt too: both get the mark.
        await page.evaluate(`window.__app.newThread(${R})`)
        const t2 = await page.evaluate<string>('window.__app.active.key')
        await send(t2, 'edit two')
        await settled('window.__app.active')
        const s2 = await page.evaluate<string>('window.__app.active.sessionPath')
        await page.evaluate(`window.__app.refreshEdits(${R})`)
        await until('conflict marks on both tabs', () => page.evaluate<boolean>(`document.querySelectorAll('[role="tab"] [role="img"][aria-label^="Shares changed files"]').length === 2`))
        check(true, 'two threads changing a.txt: both tabs get the conflict mark')
        const conflicts = await page.evaluate<any[]>(`JSON.parse(JSON.stringify(window.__app.conflictsOf(${R}, ${JSON.stringify(s1)})))`)
        check(conflicts.length === 1 && conflicts[0].file === 'a.txt', 'only the shared file counts as a conflict')

        // The panel, scoped to this thread: thread two's files only.
        await page.evaluate('(() => { if (!window.__app.reviewOpen) window.__app.toggleReview(); return true })()')
        await until('review panel', () => page.evaluate<boolean>(`document.body.innerText.includes('two.ts')`))
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('This thread')).click()`)
        await until('scoped to thread', () => page.evaluate<boolean>(`document.body.innerText.includes('two.ts') && !document.body.innerText.includes('one.ts')`))
        check(true, '"This thread" shows only the files the thread edited')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'review-thread.png'))
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('All')).click()`)

        // ---------------------------------------------------------------- commit / roll back
        const hash = await page.evaluate<string>(`window.pi.gitCommit(${R}, 'Add one', ['src/one.ts'])`)
        check(/^[0-9a-f]{7,}$/.test(hash) && git(repo, 'log', '-1', '--format=%s') === 'Add one', 'commit runs git commit with the message')
        check(git(repo, 'show', '--name-only', '--format=', 'HEAD') === 'src/one.ts', 'only the checked file went into the commit')
        // Untracked files go to the Trash (git.test.ts covers that); keep the real Trash out of it here.
        await page.evaluate(`window.pi.gitDiscard(${R}, [{ path: 'a.txt', status: ' M' }])`)
        check(await readFile(path.join(repo, 'a.txt'), 'utf8') === 'original\n', 'roll back restores a modified file')
        check(git(repo, 'status', '--porcelain') === '?? src/two.ts', 'and leaves the files it was not given')

        // ---------------------------------------------------------------- previews: images, PDF
        // A committed 3×2 PNG replaced by a 4×2 one shows both versions; a new PDF shows in a frame.
        const png = (b64: string) => Buffer.from(b64, 'base64')
        await writeFile(path.join(repo, 'logo.png'), png('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGO8o6HBAAZMEIqBgQEAFggBMBhSqiYAAAAASUVORK5CYII='))
        git(repo, 'add', 'logo.png')
        git(repo, 'commit', '-q', '-m', 'logo')
        await writeFile(path.join(repo, 'logo.png'), png('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAFElEQVR4nGPUqLjDAANMcBYDAwMAIzoBgAnDRVoAAAAASUVORK5CYII='))
        await writeFile(path.join(repo, 'spec.pdf'), tinyPdf())
        await page.evaluate(`document.querySelector('button[aria-label="Refresh"]').click()`)
        const row = (file: string) => `document.querySelector('[role="button"][title=${JSON.stringify(file)}]')`
        await until('preview rows', () => page.evaluate<boolean>(`!!${row('logo.png')} && !!${row('spec.pdf')}`))
        await page.evaluate(`(() => { for (const f of ['logo.png', 'spec.pdf']) { const r = document.querySelector('[role="button"][title="' + f + '"]'); if (r.getAttribute('aria-expanded') !== 'true') r.click() } return true })()`)
        const sizes = await until('both image versions', () => page.evaluate<string[] | null>(`(() => {
            const imgs = [...document.querySelectorAll('aside img')].filter(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth)
            return imgs.length === 2 ? imgs.map(i => i.naturalWidth + 'x' + i.naturalHeight) : null
        })()`))
        check(sizes.join() === '3x2,4x2', 'a changed image shows the committed and the working version')
        check(await page.evaluate<boolean>(`document.querySelector('aside').innerText.includes('Before') && document.querySelector('aside').innerText.includes('4 × 2')`), 'labelled Before / After, with their pixel size')
        check(await page.evaluate<boolean>(`!!document.querySelector('aside iframe[src^="blob:"]')`), 'a new PDF shows in a frame')
        if (SHOTS) {
            await new Promise(r => setTimeout(r, 1500))
            await page.screenshot(path.join(SHOTS, 'review-preview.png'))
        }
        git(repo, 'add', 'logo.png', 'spec.pdf')
        git(repo, 'commit', '-q', '-m', 'previews')

        // Rendered text (Markdown, CSV, HTML, notebook), a font, an archive and a QuickLook document.
        await writeFile(path.join(repo, 'notes.md'), '# Old title\n')
        execFileSync('zip', ['-q', 'pack.zip', 'a.txt'], { cwd: repo })
        git(repo, 'add', 'notes.md', 'pack.zip')
        git(repo, 'commit', '-q', '-m', 'docs')
        await writeFile(path.join(repo, 'notes.md'), '# New title\n\n- **bold** item\n')
        await rm(path.join(repo, 'pack.zip'))
        execFileSync('zip', ['-q', 'pack.zip', 'a.txt', 'logo.png'], { cwd: repo })
        await writeFile(path.join(repo, 'table.csv'), 'name,qty\n"Widget, large",3\nBolt,12\n')
        await writeFile(path.join(repo, 'page.html'), '<h1>Hello page</h1><script>parent.__ran = true</script>')
        await writeFile(path.join(repo, 'nb.ipynb'), JSON.stringify({
            metadata: { language_info: { name: 'python' } },
            cells: [
                { cell_type: 'markdown', source: ['## Notebook heading'] },
                { cell_type: 'code', execution_count: 1, source: ['print(6 * 7)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['42\n'] }] },
            ],
        }))
        await writeFile(path.join(repo, 'face.woff2'), await readFile(path.join(process.cwd(), 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')))
        // QuickLook (and textutil to make the document) are macOS only.
        const quickLook = existsSync('/usr/bin/textutil')
        if (quickLook) {
            await writeFile(path.join(repo, 'doc.rtf'), '{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0\\fs48 Quick look}')
            execFileSync('textutil', ['-convert', 'docx', '-output', 'doc.docx', 'doc.rtf'], { cwd: repo })
            await rm(path.join(repo, 'doc.rtf'))
        }
        const more = ['notes.md', 'pack.zip', 'table.csv', 'page.html', 'nb.ipynb', 'face.woff2', ...quickLook ? ['doc.docx'] : []]
        await page.evaluate(`document.querySelector('button[aria-label="Refresh"]').click()`)
        await until('more preview rows', () => page.evaluate<boolean>(`${JSON.stringify(more)}.every(f => document.querySelector('[role="button"][title="' + f + '"]'))`))
        await page.evaluate(`(() => { for (const f of ${JSON.stringify(more)}) { const r = document.querySelector('[role="button"][title="' + f + '"]'); if (r.getAttribute('aria-expanded') !== 'true') r.click() } return true })()`)
        // Text formats open on their diff; switch every one to the rendering.
        await until('preview switches', () => page.evaluate<boolean>(`document.querySelectorAll('aside [aria-label="Show as"] button').length >= 6`))
        await page.evaluate(`[...document.querySelectorAll('aside [aria-label="Show as"] button')].filter(b => b.textContent === 'Preview' && b.getAttribute('aria-pressed') !== 'true').forEach(b => b.click())`)
        const aside = `document.querySelector('aside')`
        await until('markdown rendered', () => page.evaluate<boolean>(`[...${aside}.querySelectorAll('.markdown-body h1')].some(h => h.textContent === 'New title')`))
        check(await page.evaluate<boolean>(`${aside}.innerText.includes('Before') && !!${aside}.querySelector('.markdown-body strong')`), 'Markdown renders, with a Before / After switch')
        check(await page.evaluate<boolean>(`[...${aside}.querySelectorAll('td')].some(td => td.textContent === 'Widget, large')`), 'CSV shows as a table, quoted commas kept')
        const frame = await until('html frame', () => page.evaluate<{ sandbox: string, srcdoc: boolean } | null>(`(() => { const f = ${aside}.querySelector('iframe[srcdoc]'); return f ? { sandbox: f.getAttribute('sandbox'), srcdoc: f.srcdoc.includes('Hello page') } : null })()`))
        check(frame.sandbox === '' && frame.srcdoc && !(await page.evaluate<boolean>('!!window.__ran')), 'HTML renders in a sandboxed frame, its scripts do not run')
        check(await page.evaluate<boolean>(`${aside}.innerText.includes('Notebook heading') && ${aside}.innerText.includes('In [1]') && ${aside}.innerText.includes('42')`), 'a notebook shows its cells and outputs')
        await until('font loaded', () => page.evaluate<boolean>(`[...document.fonts].some(f => f.family.startsWith('filo-preview') && f.status === 'loaded')`))
        check(await page.evaluate<boolean>(`${aside}.innerText.includes('The quick brown fox')`), 'a font shows sample text in itself')
        await until('archive entries', () => page.evaluate<boolean>(`${aside}.innerText.includes('1 added')`))
        check(await page.evaluate<boolean>(`[...${aside}.querySelectorAll('.font-mono span')].some(s => s.textContent.includes('added logo.png'))`), 'an archive lists its entries, marking the added one')
        if (quickLook) {
            await until('quicklook thumbnail', () => page.evaluate<boolean>(`[...${aside}.querySelectorAll('img[alt="doc.docx"]')].some(i => i.complete && i.naturalWidth > 0)`), 20_000)
            check(true, 'a document gets its QuickLook thumbnail')
        }
        if (SHOTS) {
            await new Promise(r => setTimeout(r, 1000))
            for (const f of more) {
                await page.evaluate(`(() => { /* the row's wrapper: the header itself is sticky */ const r = document.querySelector('[role="button"][title="${f}"]'); const list = r.closest('.overflow-y-auto'); list.scrollTop += r.parentElement.getBoundingClientRect().top - list.getBoundingClientRect().top; return true })()`)
                await new Promise(r => setTimeout(r, 300))
                await page.screenshot(path.join(SHOTS, `review-preview-${f}.png`))
            }
        }
        git(repo, 'add', ...more)
        git(repo, 'commit', '-q', '-m', 'more previews')

        // ---------------------------------------------------------------- fork
        await page.evaluate(`window.__app.focus(${JSON.stringify(s1)})`)
        await send(s1, 'second question')
        await settled(`window.__app.threads.get(${JSON.stringify(s1)})`)
        const original = await page.evaluate<number>(`window.__app.threads.get(${JSON.stringify(s1)}).items.length`)
        const entry = await page.evaluate<string>(`window.__app.threads.get(${JSON.stringify(s1)}).items.filter(i => i.message.role === 'user')[1].key`)
        await page.evaluate(`window.__app.forkThread(window.__app.threads.get(${JSON.stringify(s1)}), ${JSON.stringify(entry)}, false)`)
        const fork = await until('fork tab', () => page.evaluate<{ key: string, draft: string, users: number } | null>(`(() => { const t = window.__app.active; return t && t.key !== ${JSON.stringify(s1)} && t.draft ? { key: t.key, draft: t.draft, users: t.items.filter(i => i.message.role === 'user').length } : null })()`))
        check(fork.draft === 'second question', 'fork opens a new tab with the prompt back in the composer')
        check(fork.users === 1 && fork.key !== s1 && fork.key.endsWith('.jsonl'), 'the fork holds the turns before it, in a session of its own')
        check(await page.evaluate<number>(`window.__app.threads.get(${JSON.stringify(s1)}).items.length`) === original, 'the original thread is untouched')
        // Ask again from a later prompt, in place: every frame shows the same pane and the turns before it,
        // never a blank thread that refills.
        await send(fork.key, 'third question')
        await settled(`window.__app.threads.get(${JSON.stringify(fork.key)})`)
        const third = await page.evaluate<string>(`window.__app.threads.get(${JSON.stringify(fork.key)}).items.filter(i => i.message.role === 'user')[1].key`)
        await page.evaluate(`(() => {
            const pane = () => document.querySelector('section[aria-label]')
            const first = pane()
            const w = window.__askAgain = { min: Infinity, remounted: false, done: false }
            const tick = () => {
                w.min = Math.min(w.min, window.__app.active.items.length)
                w.remounted ||= pane() !== first
                if (!w.done)
                    requestAnimationFrame(tick)
            }
            tick()
            void window.__app.forkThread(window.__app.threads.get(${JSON.stringify(fork.key)}), ${JSON.stringify(third)}, true).then(() => { w.done = true })
            return true
        })()`)
        const watched = await until('ask again in place', () => page.evaluate<{ min: number, remounted: boolean, key: string, draft: string, users: number } | null>(`(() => { const w = window.__askAgain, t = window.__app.active; return w.done ? { min: w.min, remounted: w.remounted, key: t.key, draft: t.draft, users: t.items.filter(i => i.message.role === 'user').length } : null })()`))
        check(watched.key === fork.key && watched.draft === 'third question' && watched.users === 1, 'ask again stays in the same session, keeps the turns before the prompt and puts it back in the composer')
        check(watched.min > 0 && !watched.remounted, 'ask again never blanks the transcript or remounts the pane')
        const onDisk = await page.evaluate<number>(`window.pi.readSession(${JSON.stringify(fork.key)}).then(s => s.items.filter(i => i.message.role === 'user').length)`)
        check(onDisk === 1, 'the file\'s active branch moved back too, so a restarted pi resumes there')
        await page.evaluate(`(() => { window.__app.active.draft = ''; return true })()`)
        // Ask again from thread two's only prompt: nothing is left before it.
        const firstOfTwo = await page.evaluate<string>(`window.__app.threads.get(${JSON.stringify(s2)}).items.find(i => i.message.role === 'user').key`)
        await page.evaluate(`window.__app.forkThread(window.__app.threads.get(${JSON.stringify(s2)}), ${JSON.stringify(firstOfTwo)}, true)`)
        const inPlace = await until('ask again from the first prompt', () => page.evaluate<{ key: string, draft: string, items: number } | null>(`(() => { const t = window.__app.active; return t && t.draft === 'edit two' ? { key: t.key, draft: t.draft, items: t.items.length } : null })()`))
        check(inPlace.key === s2 && inPlace.items === 0, 'ask again from the first prompt empties the same thread, with the prompt to edit')
        await page.evaluate(`(() => { window.__app.active.draft = ''; return true })()`)

        // ---------------------------------------------------------------- search
        const results = await page.evaluate<any[]>(`window.pi.searchSessions('second QUESTION')`)
        check(results.length === 1 && results[0].session === s1 && results[0].hits[0].role === 'user', 'search finds the prompt (case-insensitive), in the thread that has it')
        check((await page.evaluate<any[]>(`window.pi.searchSessions('changed by')`)).length === 0, 'tool calls and their output are not searched')
        await page.evaluate(`window.__app.focus(${JSON.stringify(fork.key)})`)
        await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: COMMAND | 8, windowsVirtualKeyCode: 70 })
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: COMMAND | 8, windowsVirtualKeyCode: 70 })
        await until('search dialog', () => page.evaluate<boolean>(`!!document.querySelector('[role="dialog"] input')`))
        await page.call('Input.insertText', { text: 'second question' })
        await until('search results', () => page.evaluate<boolean>(`document.querySelectorAll('[role="dialog"] [role="option"]').length >= 2`))
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'search.png'))
        // Down to the matching prompt, then open it.
        await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
        await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await until('result opened', () => page.evaluate<boolean>(`window.__app.activeKey === ${JSON.stringify(s1)} && !window.__app.searchOpen`))
        check(await page.evaluate<boolean>(`window.__app.reveal?.entryId === ${JSON.stringify(entry)}`), '⌘⇧F → Enter opens the thread at the matching message')
        await until('revealed row flashes', () => page.evaluate<boolean>(`!!document.querySelector('[data-revealed]')`), 5000)
        check(true, 'the transcript scrolls to it and marks it')

        // ---------------------------------------------------------------- terminal presence
        // Thread two's session, its tab closed, is "open in a terminal".
        await page.evaluate(`window.__app.closeTab(${JSON.stringify(s2)})`)
        const presenceDir = path.join(agentDir, 'pi-kit-presence')
        await mkdir(presenceDir, { recursive: true })
        await writeFile(path.join(presenceDir, `${sleeper.pid}.json`), JSON.stringify({ pid: sleeper.pid, cwd: repo, session: s2, state: 'running', since: Date.now() - 65_000 }))
        await until('terminal status in the tree', () => page.evaluate<boolean>(`!!document.querySelector('[role="treeitem"] [aria-label="pi in a terminal: running"]')`), 10_000)
        check(true, 'a running terminal pi shows its spinner in the project tree')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'presence.png'))
        sleeper.kill()
        await until('terminal status gone', () => page.evaluate<boolean>(`!document.querySelector('[role="treeitem"] [aria-label^="pi in a terminal"]')`), 10_000)
        check(true, 'it goes away when that pi exits (file left behind and all)')

        // ---------------------------------------------------------------- tabs between windows
        const agentId = await page.evaluate<string>(`window.__app.threads.get(${JSON.stringify(s1)}).agentId`)
        await page.evaluate(`window.__app.moveTabToWindow(${JSON.stringify(s1)}, null)`)
        page.close()
        wins = await windows(2)
        const torn = await until('torn-off window', async () => {
            for (const w of wins) {
                if (await w.page.evaluate<boolean>(`window.__app.threads.has(${JSON.stringify(s1)})`))
                    return w
            }
        })
        const source = wins.find(w => w !== torn)!
        check(torn.projects.join() === repo && source.projects.join() === repo, 'the project now shows in both windows')
        check(await torn.page.evaluate<string>(`window.__app.threads.get(${JSON.stringify(s1)}).agentId`) === agentId, 'the torn-off tab keeps its pi process')
        check(await torn.page.evaluate<number>('window.__app.tabs.length') === 1, 'and is the new window\'s only tab')
        check(!(await source.page.evaluate<boolean>(`window.__app.threads.has(${JSON.stringify(s1)})`)), 'the source window no longer has it')
        page = torn.page
        await send(s1, 'after the move')
        await settled(`window.__app.threads.get(${JSON.stringify(s1)})`)
        check(await page.evaluate<boolean>(`JSON.stringify(window.__app.threads.get(${JSON.stringify(s1)}).items.at(-1).message.content).includes('echo: after the move')`), 'its pi process answers in the new window')
        // Opening it from the other window's tree brings this window forward instead of a second copy.
        await source.page.evaluate(`window.__app.openSession(window.__app.sessions.find(s => s.path === ${JSON.stringify(s1)}))`)
        await new Promise(r => setTimeout(r, 500))
        check(!(await source.page.evaluate<boolean>(`window.__app.threads.has(${JSON.stringify(s1)})`)), 'a session is a tab in one window only')
        if (SHOTS)
            await page.screenshot(path.join(SHOTS, 'torn-off.png'))
        await new Promise(r => setTimeout(r, 500))
        wins.forEach(w => w.page.close())
    }
    finally {
        await stop()
    }

    const state = JSON.parse(await readFile(path.join(userData, 'state.json'), 'utf8'))
    const saved: string[][] = state.windows.map((w: any) => w.tabs?.[repo] ?? [])
    check(saved.length === 2 && saved.some(t => t.join() === movedSession) && saved.every(t => t.length) && !saved[0].some(k => saved[1].includes(k)), 'both windows saved, each with its own tabs')

    stop = await launch(env)
    try {
        const wins = await windows(2)
        const keys = await Promise.all(wins.map(w => until('tabs restored', () => w.page.evaluate<string[] | null>('window.__app.tabs.length ? window.__app.tabs.map(t => t.key) : null'))))
        const all = keys.flat()
        check(new Set(all).size === all.length, `after a restart each window restores its own tabs, none twice (${keys.map(k => k.length).join(' + ')})`)
        const s1 = keys.find(k => k.length === 1)![0]
        const torn = wins[keys.findIndex(k => k.length === 1)]
        const home = wins.find(w => w !== torn)!
        const tornId = await torn.page.evaluate<number>('window.__app.windowId')
        // Dragged back onto the first window's tab bar: the emptied window closes.
        await home.page.evaluate(`window.__app.pullTab({ window: ${tornId}, key: ${JSON.stringify(s1)}, cwd: ${R} }, 0)`)
        torn.page.close()
        const after = await windows(1)
        check(await after[0].page.evaluate<boolean>(`window.__app.tabs[0]?.key === ${JSON.stringify(s1)}`), 'dragging it back puts it first in the other window, and the empty window closes')
        after.forEach(w => w.page.close())
    }
    finally {
        await stop()
        sleeper.kill()
        await llm.close()
    }
    console.log(`all feature checks passed (port ${PORT})`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
