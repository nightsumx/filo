import { describe, expect, it } from 'vitest'
import { isReadOnlyCommand } from '../packages/capabilities/lib/readonly'

describe('isReadOnlyCommand', () => {
    it.each([
        'ls -la',
        'git status && ls',
        'cd src && rg -n foo',
        'git log --oneline | head -20',
        'git branch -a',
        'git remote -v',
        'git config --get user.name',
        'sed -n 1,20p file.ts',
        'find . -name "*.ts"',
        'cat a 2>/dev/null',
        'LC_ALL=C sort file',
        'env',
        'node --version',
        'npm ls',
    ])('reads: %s', (command) => {
        expect(isReadOnlyCommand(command)).toBe(true)
    })

    it.each([
        'rm -rf src',
        'echo hi > out.txt',
        'cat $(which foo)',
        'touch a',
        'sed -i s/a/b/ file',
        "sed -n 'w out' file",
        'find . -delete',
        'find . -exec rm {} \\;',
        'fd -x rm',
        'git branch -D main',
        'git remote add origin x',
        'git push',
        'git diff --output=patch',
        'env rm -rf /',
        'GIT_PAGER=evil git log',
        'sort -o out in',
        'uniq in out',
        "awk 'BEGIN{system(\"rm x\")}'",
        'npm install',
        'npm audit fix',
        'ls & rm x',
        'cd a b',
        'node script.js',
        'unknowncmd',
    ])('may write: %s', (command) => {
        expect(isReadOnlyCommand(command)).toBe(false)
    })
})
