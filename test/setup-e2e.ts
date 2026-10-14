// End-to-end check of the setup assistant in the built app, on a machine made empty for the run: a
// throwaway HOME and a login shell (zsh, ZDOTDIR) whose PATH has none of the tools.
//   - it shows on first launch (here an existing user's, over a project window), with no pi on the machine; every tool reads as not installed
//   - Install runs the installer in the page's terminal; it asks a question, answered by typing into
//     that terminal; when it ends the login shell is asked again and the tool shows as installed
//   - an installer that fails says so, and the tool stays not installed
//   - installing pi makes it the pi the app runs
//   - page 2 offers only installed agents; the choice is saved, new threads start with it
//   - Settings → Agents shows the default and opens the assistant again
// The installers are stand-ins (PI_GUI_SETUP_INSTALL_<ID>); the real ones are checked in a clean VM.
//
//   bun run build && bun --tsconfig-override=tsconfig.node.json test/setup-e2e.ts
//   SHOTS=<dir> also saves screenshots of both pages, dark and light.
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { check, launch, until, windows, workDir } from './app'

const WORK = workDir('pi-gui-setup')
const SHOTS = process.env.SHOTS ?? ''

async function main() {
    if (process.platform === 'win32')
        throw new Error('setup-e2e needs a POSIX login shell')
    await rm(WORK, { recursive: true, force: true })
    const home = path.join(WORK, 'home')
    const zdot = path.join(WORK, 'zdot')
    const bin = path.join(WORK, 'bin')
    const userData = path.join(WORK, 'userdata')
    const agentDir = path.join(WORK, 'agent')
    const repo = path.join(WORK, 'repo')
    await Promise.all([home, zdot, bin, userData, agentDir, repo].map(d => mkdir(d, { recursive: true })))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    // zsh reads these after /etc/zprofile, so PATH is exactly this.
    await writeFile(path.join(zdot, '.zshrc'), `export PATH="${bin}:/usr/bin:/bin"\n`)

    // Codex's stand-in asks first, as real installers do, then installs codex into a folder of its own
    // and puts that on PATH in the shell profile: only asking the login shell again finds it.
    const codexInstaller = path.join(WORK, 'install-codex.sh')
    await writeFile(codexInstaller, [
        '#!/bin/sh',
        'printf "Install Codex into ~/tools/bin? [y/N] "',
        'read answer',
        '[ "$answer" = y ] || { echo cancelled; exit 1; }',
        'mkdir -p "$HOME/tools/bin"',
        'printf \'#!/bin/sh\\necho "codex-cli 0.162.0"\\n\' > "$HOME/tools/bin/codex"',
        'chmod +x "$HOME/tools/bin/codex"',
        'echo \'export PATH="$HOME/tools/bin:$PATH"\' >> "$ZDOTDIR/.zshrc"',
        'echo "codex installed"',
        '',
    ].join('\n'))
    await chmod(codexInstaller, 0o755)

    await writeFile(path.join(userData, 'state.json'), JSON.stringify({ projects: [repo], hiddenProjects: [], tabs: {}, activeTabs: {}, layout: 'single', theme: 'dark', lang: 'en', windows: [{ projects: [repo] }] }))
    const env: Record<string, string> = {
        PI_GUI_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
        PI_GUI_TEST: '1',
        PI_GUI_SKIP_SETUP: '',
        HOME: home,
        SHELL: '/bin/zsh',
        ZDOTDIR: zdot,
        PI_GUI_SETUP_INSTALL_CODEX: codexInstaller,
        PI_GUI_SETUP_INSTALL_PI: `printf '#!/bin/sh\\necho 1.0.4\\n' > "${bin}/pi" && chmod +x "${bin}/pi"`,
        PI_GUI_SETUP_INSTALL_CLAUDE: 'echo "network is down" && exit 7',
        // Succeeds, but puts grok nowhere the shell looks.
        PI_GUI_SETUP_INSTALL_GROK: 'echo "installed somewhere else"',
    }
    for (const key of Object.keys(process.env)) {
        if (key.endsWith('_API_KEY') || key.endsWith('_TOKEN') || key.startsWith('AWS_'))
            env[key] = ''
    }

    const stop = await launch(env)
    try {
        const [{ page }] = await windows(1)
        const js = (code: string) => page.evaluate<any>(code)
        // At the window's own size and pixel ratio: an emulated ratio leaves xterm's WebGL canvas drawn for the old one.
        const shot = async (name: string) => {
            const { data } = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'png' })
            await writeFile(path.join(SHOTS, name), Buffer.from(data, 'base64'))
        }
        const row = (id: string) => `document.querySelector('[data-setup-tool="${id}"]')`
        const clickIn = (scope: string, text: string) => js(`(() => { const b = [...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (!b) return false; b.click(); return true })()`)
        const installed = (id: string) => js(`${row(id)}?.dataset.installed === 'true'`)

        // ---------------------------------------------------------------- page 1
        await until('the assistant', () => js(`!!document.querySelector('main[aria-label="Setup assistant"]')`), 20_000)
        check(await js(`!document.querySelector('[data-transcript]')`), 'it shows instead of the project window')
        await until('the probe', () => js(`document.querySelectorAll('[data-setup-tool]').length === 5`), 20_000)
        for (const id of ['node', 'pi', 'claude', 'codex', 'grok'])
            check(!await installed(id), `${id} reads as not installed on an empty machine`)
        check(await js(`window.__app.env?.ok === false`), 'there is no pi to run yet')
        check(await js(`(${row('node')}.querySelector('button')?.title ?? '').includes('nodejs.org') || (${row('node')}.querySelector('button')?.title ?? '').startsWith('brew')`), 'Node.js installs from nodejs.org (no Homebrew on this PATH)')

        check(await clickIn(row('codex'), 'Install'), 'Install starts Codex\'s installer')
        await until('the installer\'s terminal', () => js(`!!document.querySelector('main section .xterm')`), 10_000)
        check(await js(`[...document.querySelectorAll('[data-setup-tool] button')].every(b => b.disabled || !['Install'].includes(b.textContent.trim()))`), 'other installs wait while one runs')
        check(await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue').disabled`), 'Continue waits for it')
        const setupTerminal = () => js(`window.__setupTerminal ??= (async () => (await window.pi.terminals()).find(t => t.by === 'setup'))()`)
        const term = await until('setup terminal listed', setupTerminal, 5_000)
        check(term.cwd === home, 'it runs in the home folder')
        await until('the question', async () => (await js(`window.pi.terminalText(${JSON.stringify(term.id)})`)).includes('[y/N]'), 10_000)
        check(await js(`!(window.__app.windowProjects.length && document.querySelector('[role="tablist"] [title*="install-codex"]'))`), 'the project\'s Terminal panel does not list it')
        if (SHOTS)
            await shot('setup-tools-dark.png')
        // Typed into the page's terminal, as the user would.
        await js(`document.querySelector('main section .xterm textarea').focus()`)
        await page.call('Input.insertText', { text: 'y' })
        await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await until('codex installed', () => installed('codex'), 20_000)
        check(await js(`${row('codex')}.textContent.includes('0.162.0')`), 'the row shows its version')
        check(await js(`${row('codex')}.textContent.includes(${JSON.stringify(path.join(home, 'tools/bin/codex'))})`), 'and where it is')
        check((await js(`window.pi.terminalText(${JSON.stringify(term.id)})`)).includes('codex installed'), 'the installer\'s output stays on the page')
        check(await js(`document.querySelector('main section [role="status"]').textContent`) === 'Codex installer finished', 'the terminal says it finished')
        const agents = await js(`window.pi.listAgents()`)
        check(agents.find((a: any) => a.id === 'codex')?.available === true, 'the rest of the app finds the new codex (PATH asked again)')

        check(await clickIn(row('pi'), 'Install'), 'Install starts pi\'s installer')
        await until('pi installed', () => installed('pi'), 20_000)
        await until('the app runs it', () => js(`window.__app.env?.ok === true && window.__app.env.env.piPath === ${JSON.stringify(path.join(bin, 'pi'))}`), 10_000)
        check(true, 'the installed pi is the one the app runs')

        check(await clickIn(row('claude'), 'Install'), 'Install starts Claude Code\'s installer')
        await until('claude failed', () => js(`/failed \\(exit code 7\\)/.test(document.querySelector('main section [role="status"]')?.textContent ?? '')`), 20_000)
        check(await js(`(await window.pi.terminals()).filter(t => t.by === 'setup').length`) === 1, 'the earlier installer\'s terminal was closed')
        await until('probe after the failure', () => js(`!${row('claude')}.querySelector('button').disabled`), 10_000)
        check(!await installed('claude'), 'a failed install leaves it not installed')
        check(await js(`!${row('claude')}.textContent.includes('does not find it yet')`), 'and the row leaves the failure to the terminal')
        if (SHOTS)
            await shot('setup-failed-dark.png')
        check(await clickIn(row('grok'), 'Install'), 'Install starts Grok\'s installer')
        await until('grok installer finished', () => js(`document.querySelector('main section [role="status"]')?.textContent === 'Grok Build installer finished'`), 20_000)
        await until('probe after grok', () => js(`${row('grok')}.textContent.includes('does not find it yet')`), 10_000)
        check(!await installed('grok'), 'an installer that succeeds without the shell finding the tool says so')

        // ---------------------------------------------------------------- page 2
        check(await clickIn('document', 'Continue'), 'Continue')
        await until('page 2', () => js(`!!document.querySelector('[role="radiogroup"][aria-label="Default agent"]')`), 5_000)
        const choice = (id: string) => `document.querySelector('[data-agent-choice="${id}"]')`
        check(await js(`${choice('pi')}.getAttribute('aria-checked')`) === 'true', 'pi is picked to begin with')
        check(await js(`${choice('codex')}.getAttribute('aria-disabled')`) === 'false', 'installed Codex can be picked')
        check(await js(`${choice('claude')}.getAttribute('aria-disabled')`) === 'true' && await js(`${choice('grok')}.getAttribute('aria-disabled')`) === 'true', 'agents not installed cannot')
        await js(`${choice('claude')}.click()`)
        check(await js(`${choice('claude')}.getAttribute('aria-checked')`) === 'false', 'clicking one not installed does nothing')
        await js(`${choice('codex')}.click()`)
        check(await js(`${choice('codex')}.getAttribute('aria-checked')`) === 'true', 'Codex picked')
        if (SHOTS)
            await shot('setup-agent-dark.png')
        if (SHOTS) {
            await js(`window.__app.setTheme('light')`)
            await until('light theme', () => js(`!document.documentElement.classList.contains('dark')`), 5_000)
            await shot('setup-agent-light.png')
            await clickIn('document', 'Back')
            await until('page 1 again', () => js(`document.querySelectorAll('[data-setup-tool]').length === 5`), 10_000)
            await shot('setup-tools-light.png')
            await clickIn('document', 'Continue')
            await until('page 2 again', () => js(`!!document.querySelector('[data-agent-choice="codex"]')`), 5_000)
            await js(`${choice('codex')}.click()`)
            await js(`window.__app.setTheme('dark')`)
        }
        check(await clickIn('document', 'Get started'), 'Get started')
        await until('the project window', () => js(`!document.querySelector('main[aria-label="Setup assistant"]')`), 10_000)
        check(await js(`window.__app.windowProjects.length === 1 && !window.__app.setupOpen`), 'the project window is back')
        await until('saved', async () => {
            const s = JSON.parse(await readFile(path.join(userData, 'state.json'), 'utf8'))
            return s.setupDone === 1 && s.defaultAgent === 'codex'
        }, 5_000)
        check(await js(`(await window.pi.terminals()).every(t => t.by !== 'setup')`), 'its terminal went with it')
        await js(`(() => { window.__app.newThread(${JSON.stringify(repo)}); return true })()`)
        check(await js(`window.__app.active.agent`) === 'codex', 'a new thread starts with Codex')

        // ---------------------------------------------------------------- Settings → Agents
        await js(`(() => { window.__app.settingsPage = 'agents'; window.__app.settingsOpen = true; return true })()`)
        const dialog = `document.querySelector('[role="dialog"]')`
        await until('agents page', () => js(`!!${dialog}?.textContent.includes('New threads start with')`), 5_000)
        check(await js(`[...${dialog}.querySelectorAll('[role="radio"]')].find(b => b.getAttribute('aria-checked') === 'true')?.textContent`) === 'Codex', 'the page shows the default')
        check(await clickIn(dialog, 'Open'), 'Open the assistant again')
        await until('assistant again', () => js(`!!document.querySelector('main[aria-label="Setup assistant"]')`), 5_000)
        check(await js(`!document.querySelector('[role="dialog"]')`), 'Settings closed for it')
        await until('probe again', () => installed('codex'), 20_000)
        check(true, 'it opens on page 1 with what is installed now')
    }
    finally {
        await stop()
    }
    console.log('all setup checks passed')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
