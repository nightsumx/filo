#!/bin/bash
# Installs or updates Filo from the latest GitHub release:
#   curl -fsSL https://filoapp.dev/install.sh | bash
#
# macOS (Apple Silicon): the app is ad-hoc signed, not notarized. Files fetched with curl carry no
# quarantine flag, so Gatekeeper does not stop the first launch; downloads from a browser would need
# "Open Anyway".
# Linux (x64, arm64): the AppImage goes to ~/.local/share/filo, with `filo` in ~/.local/bin and an
# app menu entry; the download is checked against the release's SHA-256. No root needed.
# The app runs the user's pi when the login shell has one, and its own built-in pi otherwise, so
# neither Node nor the pi CLI is needed.
#
# FILO_URL and FILO_INSTALL_DIR override the download and the target folder (used by tests); on
# Linux the checksum is read from FILO_URL.sha256.
set -euo pipefail

RELEASE=https://github.com/nightsumx/filo/releases/latest/download

install_mac() {
    local url="${FILO_URL:-$RELEASE/Filo-arm64-mac.zip}"
    if [ "$(uname -m)" != "arm64" ]; then
        echo "Filo for macOS is built for Apple Silicon only." >&2
        exit 1
    fi

    # /Applications needs an admin account; others get ~/Applications, which Spotlight and Launchpad see too.
    local dir
    if [ -n "${FILO_INSTALL_DIR:-}" ]; then
        dir="$FILO_INSTALL_DIR"
    elif [ -w /Applications ]; then
        dir=/Applications
    else
        dir="$HOME/Applications"
    fi
    mkdir -p "$dir"
    local dest="$dir/Filo.app"
    # Filo was called Pi up to 0.2; that bundle (same app, old id) is replaced, not left beside it.
    local old="$dir/Pi.app"
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
    curl -fL --progress-bar "$url" -o "$tmp/Filo.zip"
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
}

install_linux() {
    local arch
    case "$(uname -m)" in
        x86_64 | amd64) arch=x64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *)
            echo "Filo for Linux is built for x64 and arm64, not $(uname -m)." >&2
            exit 1
            ;;
    esac
    local url="${FILO_URL:-$RELEASE/Filo-$arch.AppImage}"
    local data="${XDG_DATA_HOME:-$HOME/.local/share}"
    local dir="${FILO_INSTALL_DIR:-$data/filo}"
    local dest="$dir/Filo.AppImage"
    local bin="$HOME/.local/bin"
    local apps="$data/applications"

    # Replacing the image under a running app pulls its files away.
    if pgrep -f "$dest" >/dev/null 2>&1; then
        echo "Filo is running. Quit it (Ctrl+Q), then run this again." >&2
        exit 1
    fi

    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    echo "Downloading Filo…"
    curl -fL --progress-bar "$url" -o "$tmp/Filo.AppImage"
    # A truncated or tampered download fails here rather than at launch.
    local expected actual
    expected="$(curl -fsSL "$url.sha256" | awk '{print $1}')"
    actual="$(sha256sum "$tmp/Filo.AppImage" | awk '{print $1}')"
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        echo "The download is damaged (checksum mismatch). Try again." >&2
        exit 1
    fi
    chmod +x "$tmp/Filo.AppImage"
    # The menu icon, out of the image itself (this needs no FUSE).
    (cd "$tmp" && ./Filo.AppImage --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1) || true

    mkdir -p "$dir" "$bin" "$apps"
    mv -f "$tmp/Filo.AppImage" "$dest"
    ln -sf "$dest" "$bin/filo"
    if [ -d "$tmp/squashfs-root/usr/share/icons/hicolor" ]; then
        mkdir -p "$data/icons/hicolor"
        cp -R "$tmp/squashfs-root/usr/share/icons/hicolor/." "$data/icons/hicolor/"
    fi
    # Named after the app's desktopName (package.json) and its window class, so the desktop puts
    # its windows under this entry.
    cat >"$apps/filo.desktop" <<EOF
[Desktop Entry]
Name=Filo
Comment=A desktop app for coding agents (pi, Codex, Claude Code and others)
Exec="$dest" %U
Icon=filo
Type=Application
Categories=Development;
Terminal=false
StartupWMClass=Filo
EOF
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$apps" >/dev/null 2>&1 || true
    fi

    echo "Installed $dest"
    # An AppImage mounts itself with FUSE; without it, it still runs when told to unpack first.
    if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
        echo "No FUSE found: install it (e.g. sudo apt install fuse3), or run Filo with APPIMAGE_EXTRACT_AND_RUN=1." >&2
    fi
    case ":$PATH:" in
        *":$bin:"*) echo "Open it from the app menu, or run: filo" ;;
        *) echo "Open it from the app menu, or run: $bin/filo ($bin is not on your PATH)" ;;
    esac
}

case "$(uname -s)" in
    Darwin) install_mac ;;
    Linux) install_linux ;;
    *)
        echo "This script installs Filo on macOS and Linux. On Windows, in PowerShell: irm https://filoapp.dev/install.ps1 | iex" >&2
        exit 1
        ;;
esac
