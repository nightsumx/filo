// Starts the bundled pi under the app's Electron running as node (ELECTRON_RUN_AS_NODE=1):
//   <Electron> piLauncher.mjs <pi cli.js> [pi args…]
// The variable is dropped right away so the commands pi runs (bash tool, user scripts, someone's own
// Electron app) see a normal environment. PI_KIT_PI_LAUNCHER tells pi's capabilities how to start
// pi again (packages/capabilities/lib/child.ts). Plain JavaScript: Electron loads it before any type stripping.
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

delete process.env.ELECTRON_RUN_AS_NODE
process.env.PI_KIT_PI_LAUNCHER = fileURLToPath(import.meta.url)
const cli = process.argv[2]
if (!cli) {
    process.stderr.write('usage: piLauncher.mjs <pi cli.js> [args…]\n')
    process.exit(2)
}
// pi reads its arguments from argv[2…] and its own location from import.meta, so it sees
// [<Electron>, <cli.js>, args…] as if node had started it.
process.argv.splice(1, 2, cli)
await import(pathToFileURL(cli).href)
