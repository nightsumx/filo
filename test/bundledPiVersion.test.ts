import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const root = path.join(__dirname, '..')
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'))
const PI = '@earendil-works/pi-coding-agent'

it('the app ships the pi version it is built and tested against', () => {
    const built = json('package.json').devDependencies[PI]
    expect(json('bundled-pi/package.json').dependencies[PI]).toBe(built)
    expect(json('bundled-pi/package-lock.json').packages[`node_modules/${PI}`].version).toBe(built)
})

it('install.sh needs no Node or pi CLI', () => {
    const script = readFileSync(path.join(root, 'scripts/install.sh'), 'utf8')
    expect(script).not.toMatch(/npm install/)
})
