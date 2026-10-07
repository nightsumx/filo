#!/bin/bash
# Installs or updates Pi from the latest GitHub release:
#   curl -fsSL https://github.com/nightsumx/pi-kit/releases/latest/download/install.sh | bash
#
# The app is ad-hoc signed, not notarized. Files fetched with curl carry no quarantine flag, so
# Gatekeeper does not stop the first launch; downloads from a browser would need "Open Anyway".
#
# PI_URL and PI_INSTALL_DIR override the download and the target folder (used by tests).
set -euo pipefail

URL="${PI_URL:-https://github.com/nightsumx/pi-kit/releases/latest/download/Pi-arm64-mac.zip}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "Pi is built for Apple Silicon Macs only." >&2
    exit 1
fi

# /Applications needs an admin account; others get ~/Applications, which Spotlight and Launchpad see too.
if [ -n "${PI_INSTALL_DIR:-}" ]; then
    dir="$PI_INSTALL_DIR"
elif [ -w /Applications ]; then
    dir=/Applications
else
    dir="$HOME/Applications"
fi
mkdir -p "$dir"
dest="$dir/Pi.app"

# Swapping the bundle under a running Electron app breaks it: it reads app.asar on demand.
if pgrep -f "$dest/Contents/MacOS/Pi" >/dev/null 2>&1; then
    echo "Pi is running. Quit it (⌘Q), then run this again." >&2
    exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Pi…"
curl -fL --progress-bar "$URL" -o "$tmp/Pi.zip"
# ditto keeps the framework symlinks and the signature intact; unzip may not.
ditto -xk "$tmp/Pi.zip" "$tmp"
# A truncated or tampered download fails here rather than at launch.
if ! codesign --verify --deep --strict "$tmp/Pi.app" 2>/dev/null; then
    echo "The download is damaged (signature check failed). Try again." >&2
    exit 1
fi
xattr -dr com.apple.quarantine "$tmp/Pi.app" 2>/dev/null || true

rm -rf "$dest"
mv "$tmp/Pi.app" "$dest"
echo "Installed $dest"
echo "Open it from Launchpad or Spotlight, or run: open \"$dest\""
