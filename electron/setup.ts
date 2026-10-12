// The setup assistant's checks and installs. A tool counts as installed when the login shell finds it
// (so a terminal can run it), or for an agent also in the folder its installer uses. Installs are the
// tools' official installers, run in a terminal the assistant shows (terminals.ts, `by: 'setup'`), so
// the user sees every step and answers its questions (sudo, PATH changes) there.
import type { OsId } from './platform'
import type { SetupProbe, SetupTool, SetupToolId } from '@shared/setup'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { acpAgent } from '@shared/agents'
import { SETUP_TOOL_IDS } from '@shared/setup'
import { refreshShellPath, resolvePiEnv } from './pi-env'
import { platform } from './platform'

/** The Node.js LTS the macOS installer package is for (nodejs.org/dist/index.tab, 2026-10-09). */
export const NODE_LTS = 'v24.21.0'

const LABELS: Record<SetupToolId, string> = { node: 'Node.js', pi: 'pi', claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build' }

/** Each agent's own installer, for a POSIX shell and for PowerShell. */
const INSTALLERS: Record<Exclude<SetupToolId, 'node'>, { sh: string, ps: string }> = {
    pi: { sh: 'curl -fsSL https://pi.dev/install.sh | sh', ps: 'irm https://pi.dev/install.ps1 | iex' },
    claude: { sh: 'curl -fsSL https://claude.ai/install.sh | bash', ps: 'irm https://claude.ai/install.ps1 | iex' },
    codex: { sh: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', ps: 'irm https://chatgpt.com/codex/install.ps1 | iex' },
    grok: { sh: 'curl -fsSL https://x.ai/cli/install.sh | bash', ps: 'irm https://x.ai/cli/install.ps1 | iex' },
}

/**
 * Node.js: Homebrew where it is set up; else on macOS nodejs.org's installer package (signed, checked
 * by `installer`), which puts node in /usr/local/bin, on every shell's PATH; winget on Windows. Linux
 * without Homebrew: none (distributions ship older versions; pi's installer brings its own node).
 * Written to work in any shell the terminal may run (zsh, bash, fish).
 */
function nodeInstaller(os: OsId, brew: boolean): string | undefined {
    if (os === 'win32')
        return 'winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements'
    if (brew)
        return 'brew install node'
    if (os !== 'darwin')
        return undefined
    const pkg = `$HOME/Library/Caches/node-${NODE_LTS}.pkg`
    return `curl -fL --retry 3 --connect-timeout 20 -o "${pkg}" https://nodejs.org/dist/${NODE_LTS}/node-${NODE_LTS}.pkg && sudo installer -pkg "${pkg}" -target / && rm -f "${pkg}"`
}

export interface SetupDeps {
    os: OsId
    home: string
    /** The login shell's PATH, read again (an installer may have just changed the profile). */
    searchPath: () => Promise<string>
    findIn: (name: string, dirs: readonly string[]) => Promise<string | undefined>
    /** `file --version`'s first line, run with PATH `searchPath`; undefined when it fails. */
    version: (file: string, searchPath: string) => Promise<string | undefined>
    /** The pi threads start, looked up again. */
    pi: () => Promise<SetupProbe['pi']>
    /** Tests: an install command per tool (PI_GUI_SETUP_INSTALL_<ID>). */
    override?: (id: SetupToolId) => string | undefined
}

const expandHome = (dir: string, home: string) => dir.replace(/^~(?=\/|$)/, home)

/** Where to look besides PATH: the folders an agent's installer uses (shared/agents.ts). */
function extraDirs(id: SetupToolId, home: string): string[] {
    if (id === 'node' || id === 'pi')
        return []
    const spec = acpAgent(id)
    return [...new Set([...spec?.cli?.dirs ?? [], ...spec?.dirs ?? []])].map(d => expandHome(d, home))
}

const binOf = (id: SetupToolId): string => id === 'node' || id === 'pi' ? id : acpAgent(id)?.cli?.bin ?? acpAgent(id)?.bin ?? id

/** The command that installs `id` here; undefined when the app has none for this machine. */
export async function installCommand(id: SetupToolId, deps: SetupDeps, searchPath?: string): Promise<string | undefined> {
    const override = deps.override?.(id)
    if (override)
        return override
    if (id === 'node') {
        const brew = deps.os !== 'win32' && !!await deps.findIn('brew', (searchPath ?? await deps.searchPath()).split(path.delimiter))
        return nodeInstaller(deps.os, brew)
    }
    return deps.os === 'win32' ? INSTALLERS[id].ps : INSTALLERS[id].sh
}

/** Version-looking part of a `--version` line: `2.1.3 (Claude Code)` → 2.1.3, `codex-cli 0.162.0` → 0.162.0. */
export function parseVersion(line: string | undefined): string | undefined {
    return line?.match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/)?.[1]
}

export async function probeSetup(deps: SetupDeps): Promise<SetupProbe> {
    const searchPath = await deps.searchPath()
    const dirs = searchPath.split(path.delimiter).filter(Boolean)
    const [tools, pi] = await Promise.all([
        Promise.all(SETUP_TOOL_IDS.map(async (id): Promise<SetupTool> => {
            const found = await deps.findIn(binOf(id), [...dirs, ...extraDirs(id, deps.home)])
            const version = found ? parseVersion(await deps.version(found, searchPath)) : undefined
            return { id, label: LABELS[id], path: found, version, install: await installCommand(id, deps, searchPath) }
        })),
        deps.pi(),
    ])
    return { tools, pi }
}

/** `file --version`, through the platform's way of starting it (a Windows .cmd shim runs under node). */
function runVersion(file: string, searchPath: string): Promise<string | undefined> {
    const { file: cmd, args, windowsVerbatimArguments } = platform.command(file, ['--version'], searchPath)
    const env = platform.withPath({ ...process.env as Record<string, string> }, searchPath)
    delete env.ELECTRON_RUN_AS_NODE
    return new Promise((resolve) => {
        execFile(cmd, args, { env, timeout: 10_000, windowsVerbatimArguments, windowsHide: true }, (_error, stdout, stderr) => {
            resolve(`${stdout}\n${stderr}`.split('\n').map(l => l.trim()).find(Boolean))
        })
    })
}

/** This machine: the login shell asked again, the pi env resolved again. */
export function liveSetupDeps(): SetupDeps {
    return {
        os: platform.id,
        home: os.homedir(),
        searchPath: refreshShellPath,
        findIn: platform.findIn,
        version: runVersion,
        pi: async () => {
            const env = await resolvePiEnv()
            return env.ok ? { bundled: !!env.env.bundled, version: env.env.version } : { error: env.error }
        },
        override: id => process.env.PI_GUI_TEST === '1' ? process.env[`PI_GUI_SETUP_INSTALL_${id.toUpperCase()}`] || undefined : undefined,
    }
}

export const SETUP_LABELS = LABELS
