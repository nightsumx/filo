// npm packs bundled dependencies from node_modules but skips symlinks, and in the workspace
// node_modules/pi-capabilities is a link to packages/capabilities. prepack swaps the link for a copy of
// the package's published files; postpack (`--restore`) puts the link back.
import { cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'node_modules', 'pi-capabilities')
const source = path.join(root, '..', 'capabilities')
const link = path.relative(path.dirname(target), source)

const isLink = () => {
    try {
        return lstatSync(target).isSymbolicLink()
    }
    catch {
        return false
    }
}

if (process.argv.includes('--restore')) {
    if (!isLink()) {
        rmSync(target, { recursive: true, force: true })
        symlinkSync(link, target, 'dir')
    }
    process.exit(0)
}

if (isLink() && path.resolve(path.dirname(target), readlinkSync(target)) !== source)
    throw new Error(`node_modules/pi-capabilities points somewhere unexpected: ${readlinkSync(target)}`)
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
for (const entry of ['package.json', ...pkg.files])
    cpSync(path.join(source, entry), path.join(target, entry), { recursive: true })
console.log(`bundled pi-capabilities ${pkg.version} (${pkg.files.join(', ')})`)
