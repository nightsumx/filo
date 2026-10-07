import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const root = path.join(__dirname, '..')

it('install.sh installs the pi version the app is built against', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const script = readFileSync(path.join(root, 'scripts/install.sh'), 'utf8')
    const pinned = /PI_PACKAGE="(.+)"/.exec(script)?.[1]
    expect(pinned).toBe(`@earendil-works/pi-coding-agent@${pkg.dependencies?.['@earendil-works/pi-coding-agent'] ?? pkg.devDependencies?.['@earendil-works/pi-coding-agent']}`)
})
