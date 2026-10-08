#!/bin/bash
# Installs or updates Filo from the latest GitHub release:
#   curl -fsSL https://filoapp.dev/install.sh | bash
#
# The app is ad-hoc signed, not notarized. Files fetched with curl carry no quarantine flag, so
# Gatekeeper does not stop the first launch; downloads from a browser would need "Open Anyway".
# The app runs the user's pi when the login shell has one, and its own built-in pi otherwise, so
# neither Node nor the pi CLI is needed.
#
# FILO_URL and FILO_INSTALL_DIR override the download and the target folder (used by tests).
set -euo pipefail

URL="${FILO_URL:-https://github.com/nightsumx/filo/releases/latest/download/Filo-arm64-mac.zip}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "Filo is built for Apple Silicon Macs only." >&2
    exit 1
fi

# /Applications needs an admin account; others get ~/Applications, which Spotlight and Launchpad see too.
if [ -n "${FILO_INSTALL_DIR:-}" ]; then
    dir="$FILO_INSTALL_DIR"
elif [ -w /Applications ]; then
    dir=/Applications
else
    dir="$HOME/Applications"
fi
mkdir -p "$dir"
dest="$dir/Filo.app"
# Filo was called Pi up to 0.2; that bundle (same app, old id) is replaced, not left beside it.
old="$dir/Pi.app"
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$old/Contents/Info.plist" 2>/dev/null)" != dev.nightsumx.pi ]; then
    old=
fi

# Swapping the bundle under a running Electron app breaks it: it reads app.asar on demand.
if pgrep -f "$dest/Contents/MacOS/Filo" >/dev/null 2>&1 || { [ -n "$old" ] && pgrep -f "$old/Contents/MacOS/Pi" >/dev/null 2>&1; }; then
    echo "Filo is running. Quit it (⌘Q), then run this again." >&2
    exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Filo…"
curl -fL --progress-bar "$URL" -o "$tmp/Filo.zip"
# ditto keeps the framework symlinks and the signature intact; unzip may not.
ditto -xk "$tmp/Filo.zip" "$tmp"
# A truncated or tampered download fails here rather than at launch.
if ! codesign --verify --deep --strict "$tmp/Filo.app" 2>/dev/null; then
    echo "The download is damaged (signature check failed). Try again." >&2
    exit 1
fi
xattr -dr com.apple.quarantine "$tmp/Filo.app" 2>/dev/null || true

rm -rf "$dest"
mv "$tmp/Filo.app" "$dest"
if [ -n "$old" ]; then
    rm -rf "$old"
    echo "Removed $old (Filo's old name)"
fi
echo "Installed $dest"
echo "Open it from Launchpad or Spotlight, or run: open \"$dest\""
