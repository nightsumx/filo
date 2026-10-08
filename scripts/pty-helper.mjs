// node-pty 1.1.0 is published with spawn-helper not executable, and every terminal then fails with
// "posix_spawnp failed". Fix the installed copy, which electron-builder packs as Resources/node-pty.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
        const helper = path.join(prebuilds, dir, 'spawn-helper')
        if (existsSync(helper))
            chmodSync(helper, statSync(helper).mode | 0o111)
    }
}
