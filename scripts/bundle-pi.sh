#!/bin/bash
# Installs the pi the app ships (bundled-pi/package-lock.json) into bundled-pi/node_modules, which
# electron-builder copies to Resources/pi. The app runs it with its own Electron as node when the
# user has no pi (electron/pi-env.ts). The npm next to it installs agents (Codex, …) on a Mac without
# Node.js (electron/acp/node.ts); pinned to a line whose engines accept Electron's node.
#
# npm ci: exactly the locked versions. --ignore-scripts: no install hooks run on the build machine;
# nothing in pi's tree needs one on macOS (esbuild ships its binary as an optional package).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/bundled-pi"
npm ci --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error
test -f node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
test -f node_modules/npm/bin/npm-cli.js
echo "bundled pi $(node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"), npm $(node -p "require('./node_modules/npm/package.json').version")"
