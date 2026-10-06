// In dev the app runs inside node_modules/electron's Electron.app, so macOS takes the menu-bar
// title, Dock / ⌘Tab label and notification sender from that bundle's Info.plist ("Electron").
// Rename the dev bundle to productName; runs on postinstall since reinstalling electron resets it.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin')
    process.exit(0)

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { productName } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const bundle = path.join(root, 'node_modules/electron/dist/Electron.app')
const plist = path.join(bundle, 'Contents/Info.plist')
if (!existsSync(plist))
    process.exit(0)

for (const key of ['CFBundleName', 'CFBundleDisplayName'])
    execFileSync('plutil', ['-replace', key, '-string', productName, plist])

// LaunchServices caches bundle names; re-register so the new one shows without a reboot.
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if (existsSync(lsregister))
    execFileSync(lsregister, ['-f', bundle])
console.log(`dev Electron.app now shows as "${productName}"`)
