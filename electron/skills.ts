// Skills every agent can use. ~/.agents/skills is the common folder: pi, Codex, OpenCode and Grok read
// it (checked in pi 0.x, Codex 0.160, OpenCode 1.18, Grok 1.0); Claude Code reads only its own
// (CLAUDE_CONFIG_DIR/skills), so a shared skill gets a link there. Nothing is stored: the folders are the
// truth, the same ones the terminal agents read.
import type { AgentKind } from '@shared/agents'
import type { SkillInfo } from '@shared/ipc'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

function folders(env: Record<string, string | undefined>, home: string) {
    const shared = path.join(home, '.agents', 'skills')
    const claude = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills')
    const dirs: { dir: string, agents: AgentKind[] }[] = [
        { dir: shared, agents: ['pi', 'codex', 'opencode', 'grok'] },
        { dir: path.join(env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'), 'skills'), agents: ['pi'] },
        { dir: claude, agents: ['claude'] },
        { dir: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills'), agents: ['codex'] },
        { dir: path.join(home, '.config', 'opencode', 'skills'), agents: ['opencode'] },
        { dir: path.join(env.GROK_HOME || path.join(home, '.grok'), 'skills'), agents: ['grok'] },
    ]
    return { shared, claude, dirs }
}

/** Every skill folder (one with a SKILL.md) in the agents' folders; a link counts, a broken one does not. */
async function scan(dirs: { dir: string, agents: AgentKind[] }[]) {
    const found: { name: string, path: string, real: string, link: boolean, agents: AgentKind[] }[] = []
    for (const { dir, agents } of dirs) {
        for (const name of await readdir(dir).catch(() => [])) {
            const entry = path.join(dir, name)
            const real = name.startsWith('.') ? '' : await realpath(entry).catch(() => '')
            if (real && existsSync(path.join(real, 'SKILL.md')))
                found.push({ name, path: entry, real, link: (await lstat(entry)).isSymbolicLink(), agents })
        }
    }
    return found
}

/** The frontmatter's description, folded onto one line. */
export function description(skillMd: string) {
    const lines = skillMd.split('\n')
    if (lines[0]?.trim() !== '---')
        return ''
    const end = lines.indexOf('---', 1)
    const head = lines.slice(1, end < 0 ? undefined : end)
    const at = head.findIndex(l => l.startsWith('description:'))
    if (at < 0)
        return ''
    const first = head[at].slice('description:'.length).trim()
    const rest = head.slice(at + 1)
    const next = rest.findIndex(l => l.trim() && !l.startsWith(' '))
    const more = next < 0 ? rest : rest.slice(0, next)
    const text = ['>', '|', '>-', '|-', ''].includes(first) ? more.map(l => l.trim()).join(' ') : first
    return text.length > 1 && (text[0] === '"' || text[0] === '\'') && text.at(-1) === text[0] ? text.slice(1, -1) : text
}

export async function listSkills(env: Record<string, string | undefined> = process.env, home = os.homedir()): Promise<SkillInfo[]> {
    const { shared, claude, dirs } = folders(env, home)
    const found = await scan(dirs)
    const claudeHome = existsSync(path.dirname(claude))
    const names = [...new Set(found.map(f => f.name))].sort((a, b) => a.localeCompare(b))
    return Promise.all(names.map(async (name) => {
        const entries = found.filter(f => f.name === name)
        const paths = [...new Set(entries.map(e => e.real))]
        return {
            name,
            description: description(await readFile(path.join(paths[0], 'SKILL.md'), 'utf8').catch(() => '')),
            agents: [...new Set(entries.flatMap(e => e.agents))],
            paths,
            shared: paths.length === 1 && entries.some(e => e.path === path.join(shared, name)) && (!claudeHome || entries.some(e => e.path === path.join(claude, name))),
        }
    }))
}

/**
 * Puts each skill in the common folder and links it into Claude Code's (when Claude Code has a folder).
 * A skill found in one agent's own folder moves to the common one, and links to it follow; one that lives
 * elsewhere gets a link. Different copies under one name are left for the user to choose from.
 */
export async function shareSkills(names: string[], env: Record<string, string | undefined> = process.env, home = os.homedir()) {
    const { shared, claude, dirs } = folders(env, home)
    const found = await scan(dirs)
    for (const name of names) {
        const entries = found.filter(f => f.name === name)
        const reals = [...new Set(entries.map(e => e.real))]
        if (reals.length !== 1)
            throw new Error(reals.length ? `${name} 有 ${reals.length} 份不同的内容，先留下一份` : `找不到技能 ${name}`)
        const target = path.join(shared, name)
        if (!entries.some(e => e.path === target)) {
            await mkdir(shared, { recursive: true })
            const own = entries.find(e => !e.link)
            if (own) {
                await rename(own.path, target)
                for (const link of entries.filter(e => e.link)) {
                    await rm(link.path)
                    await symlink(target, link.path)
                }
            }
            else {
                await symlink(reals[0], target)
            }
        }
        const link = path.join(claude, name)
        if (existsSync(path.dirname(claude)) && !(await lstat(link).catch(() => null))) {
            await mkdir(claude, { recursive: true })
            await symlink(target, link)
        }
    }
    return listSkills(env, home)
}
