// The skills and commands Claude Code has for a project, read from the folders it reads them from: skills
// (`<claude>/skills/<name>/SKILL.md`, `<project>/.claude/skills/…`) and custom commands (`<claude>/commands/**.md`,
// `<project>/.claude/commands/…`, a subfolder being a `folder:` prefix). The same files the terminal's `claude`
// lists, read-only; plugins' are not here. The TUI is not asked: it reports its list nowhere but its own screen.
import type { SlashCommand } from '@shared/pi'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { description } from '../skills'

async function skillsIn(dir: string): Promise<SlashCommand[]> {
    const found: SlashCommand[] = []
    for (const name of await readdir(dir).catch(() => [])) {
        if (name.startsWith('.'))
            continue
        const text = await readFile(path.join(dir, name, 'SKILL.md'), 'utf8').catch(() => undefined)
        if (text !== undefined)
            found.push({ name, description: description(text), source: 'skill' })
    }
    return found
}

async function commandsIn(dir: string, prefix = ''): Promise<SlashCommand[]> {
    const found: SlashCommand[] = []
    for (const name of await readdir(dir).catch(() => [])) {
        if (name.startsWith('.'))
            continue
        const file = path.join(dir, name)
        if ((await stat(file).catch(() => undefined))?.isDirectory())
            found.push(...await commandsIn(file, `${prefix}${name}:`))
        else if (name.endsWith('.md'))
            found.push({ name: `${prefix}${name.slice(0, -3)}`, description: description(await readFile(file, 'utf8').catch(() => '')), source: 'prompt' })
    }
    return found
}

/** User-level first, then the project's; a project one of the same name replaces the user's, as in Claude Code. */
export async function claudeCommands(configDir: string, cwd: string): Promise<SlashCommand[]> {
    const project = path.join(cwd, '.claude')
    const all = [
        ...await skillsIn(path.join(configDir, 'skills')),
        ...await commandsIn(path.join(configDir, 'commands')),
        ...await skillsIn(path.join(project, 'skills')),
        ...await commandsIn(path.join(project, 'commands')),
    ]
    const byName = new Map(all.map(c => [c.name, c]))
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
