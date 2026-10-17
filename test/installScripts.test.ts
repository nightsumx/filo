import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const root = path.join(__dirname, '..')

it('the install scripts need no Node.js', () => {
    for (const name of ['install.sh', 'install.ps1'])
        expect(readFileSync(path.join(root, 'scripts', name), 'utf8')).not.toMatch(/npm install/)
})
