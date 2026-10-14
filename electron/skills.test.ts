import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listSkills, shareSkills } from './skills'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })))

function home() {
    // Native: on Windows the temp folder can be an 8.3 name (RUNNER~1), and realpath in skills.ts gives the long one.
    const h = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'skills-')))
    homes.push(h)
    return h
}

function skill(dir: string, body = '---\nname: x\ndescription: Does x\n---\n') {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'SKILL.md'), body)
}

const env = {}

describe('skills', () => {
    it('lists by name with who sees them; links count, hidden and broken ones do not', async () => {
        const h = home()
        skill(path.join(h, '.agents/skills/web'))
        mkdirSync(path.join(h, '.claude/skills'), { recursive: true })
        symlinkSync(path.join(h, '.agents/skills/web'), path.join(h, '.claude/skills/web'))
        skill(path.join(h, '.codex/skills/only-codex'), '---\ndescription: >\n  Folded\n  text\nname: y\n---\n')
        skill(path.join(h, '.codex/skills/.system'))
        symlinkSync(path.join(h, 'gone'), path.join(h, '.claude/skills/broken'))
        writeFileSync(path.join(h, '.claude/skills/notes.md'), '')
        expect(await listSkills(env, h)).toEqual([
            { name: 'only-codex', description: 'Folded text', agents: ['codex'], paths: [path.join(h, '.codex/skills/only-codex')], shared: false },
            { name: 'web', description: 'Does x', agents: ['pi', 'codex', 'opencode', 'grok', 'claude'], paths: [path.join(h, '.agents/skills/web')], shared: true },
        ])
    })

    it('moves a skill from an agent folder to the common one, and links to it follow', async () => {
        const h = home()
        skill(path.join(h, '.claude/skills/review'))
        mkdirSync(path.join(h, '.pi/agent/skills'), { recursive: true })
        symlinkSync(path.join(h, '.claude/skills/review'), path.join(h, '.pi/agent/skills/review'))
        const [after] = await shareSkills(['review'], env, h)
        const shared = path.join(h, '.agents/skills/review')
        expect(lstatSync(shared).isDirectory()).toBe(true)
        expect(readlinkSync(path.join(h, '.claude/skills/review'))).toBe(shared)
        expect(readlinkSync(path.join(h, '.pi/agent/skills/review'))).toBe(shared)
        expect(after).toMatchObject({ paths: [shared], shared: true, agents: ['pi', 'codex', 'opencode', 'grok', 'claude'] })
    })

    it('links a skill that lives elsewhere, and leaves Claude Code alone when it has no folder', async () => {
        const h = home()
        skill(path.join(h, 'src/tool'))
        mkdirSync(path.join(h, '.codex/skills'), { recursive: true })
        symlinkSync(path.join(h, 'src/tool'), path.join(h, '.codex/skills/tool'))
        const [after] = await shareSkills(['tool'], env, h)
        expect(readlinkSync(path.join(h, '.agents/skills/tool'))).toBe(path.join(h, 'src/tool'))
        expect(existsSync(path.join(h, '.claude'))).toBe(false)
        expect(after.shared).toBe(true)
    })

    it('refuses different copies under one name', async () => {
        const h = home()
        skill(path.join(h, '.agents/skills/cf'))
        skill(path.join(h, '.claude/skills/cf'))
        expect((await listSkills(env, h))[0]).toMatchObject({ shared: false, paths: [path.join(h, '.agents/skills/cf'), path.join(h, '.claude/skills/cf')] })
        await expect(shareSkills(['cf'], env, h)).rejects.toThrow('2 份不同的内容')
        await expect(shareSkills(['../x'], env, h)).rejects.toThrow('找不到')
    })
})
