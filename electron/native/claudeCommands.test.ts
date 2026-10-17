import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCommands } from './claudeCommands'

const roots: string[] = []
afterEach(async () => {
    for (const r of roots.splice(0))
        await rm(r, { recursive: true, force: true })
})

async function write(file: string, text: string) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
}

describe('Claude Code commands read from its folders', () => {
    it('lists skills and custom commands of the user and the project; the project\'s replaces a same-named one', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'claude-cmds-'))
        roots.push(root)
        const config = path.join(root, 'config')
        const cwd = path.join(root, 'project')
        await write(path.join(config, 'skills', 'deploy', 'SKILL.md'), '---\ndescription: ship it\n---\nbody')
        await write(path.join(config, 'skills', 'notes', 'README.md'), 'not a skill: no SKILL.md')
        await write(path.join(config, 'commands', 'fix.md'), '---\ndescription: fix the thing\n---\nFix $ARGUMENTS')
        await write(path.join(config, 'commands', 'git', 'sync.md'), 'Sync')
        await write(path.join(config, 'commands', 'readme.txt'), 'not a command')
        await write(path.join(cwd, '.claude', 'commands', 'fix.md'), '---\ndescription: the project\'s fix\n---\n')
        await write(path.join(cwd, '.claude', 'skills', 'lint', 'SKILL.md'), '---\ndescription: lint\n---\n')
        expect(await claudeCommands(config, cwd)).toEqual([
            { name: 'deploy', description: 'ship it', source: 'skill' },
            { name: 'fix', description: 'the project\'s fix', source: 'prompt' },
            { name: 'git:sync', description: '', source: 'prompt' },
            { name: 'lint', description: 'lint', source: 'skill' },
        ])
    })

    it('is empty when there are no folders', async () => {
        expect(await claudeCommands('/nonexistent/claude', '/nonexistent/project')).toEqual([])
    })
})
