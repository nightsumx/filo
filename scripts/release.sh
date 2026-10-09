#!/bin/bash
# Builds the macOS app from the committed HEAD and publishes it as a GitHub release, tagged
# v<package.json version>, with fixed asset names so releases/latest/download/... always points at it.
# The tag also starts .github/workflows/release.yml, which builds Linux and Windows and adds them to
# the draft; the release goes public once that has passed, so every OS ships the same version.
#
# The build runs on a copy of HEAD, not the working tree: uncommitted edits (other agents share this
# folder) must not ship.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
repo=nightsumx/filo
version="$(node -p "require('./package.json').version")"
tag="v$version"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null || gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
    echo "$tag exists already: bump version in package.json first." >&2
    exit 1
fi

snap="$(mktemp -d)/filo"
trap 'rm -rf "$(dirname "$snap")"' EXIT
mkdir -p "$snap"
git archive HEAD | tar -x -C "$snap"
# Dependencies are not in git; the copy uses this checkout's.
ln -s "$root/node_modules" "$snap/node_modules"
for d in packages/*/; do
    if [ -d "$root/$d/node_modules" ]; then
        ln -s "$root/$d/node_modules" "$snap/$d/node_modules"
    fi
done

(cd "$snap" && bun run dist)

app="$snap/release/mac-arm64/Filo.app"
codesign --verify --deep --strict "$app"
out="$root/release/publish"
rm -rf "$out"
mkdir -p "$out"
cp "$snap/release/Filo-$version-arm64-mac.zip" "$out/Filo-arm64-mac.zip"
cp "$snap/release/Filo-$version-arm64.dmg" "$out/Filo-arm64.dmg"
cp scripts/install.sh scripts/install.ps1 "$out/"

# Pushing the tag publishes HEAD's commits under it without moving any branch.
git tag "$tag"
git push origin "$tag"

notes="$(cat <<EOF
Install or update.

macOS (Apple Silicon) and Linux (x64, arm64):

\`\`\`
curl -fsSL https://filoapp.dev/install.sh | bash
\`\`\`

Windows (x64), in PowerShell:

\`\`\`
irm https://filoapp.dev/install.ps1 | iex
\`\`\`

More at https://filoapp.dev.

The macOS app is not notarized. Opening the .dmg or .zip downloaded with a browser needs one extra step: open it once, then System Settings → Privacy & Security → Open Anyway. The Windows installer is not signed: downloaded with a browser, SmartScreen asks once (More info → Run anyway).
EOF
)"
gh release create "$tag" -R "$repo" --verify-tag --draft --title "Filo $version" --notes "$notes" \
    "$out/Filo-arm64-mac.zip" "$out/Filo-arm64.dmg" "$out/install.sh" "$out/install.ps1"

# The workflow run the tag started; it adds the Linux and Windows installers to the draft.
echo "Waiting for the Linux and Windows builds…"
run=""
for _ in $(seq 1 30); do
    run="$(gh run list -R "$repo" --workflow release.yml --event push --branch "$tag" --json databaseId --jq '.[0].databaseId // empty')"
    [ -n "$run" ] && break
    sleep 10
done
if [ -z "$run" ]; then
    echo "No release.yml run for $tag; the draft stays unpublished." >&2
    exit 1
fi
if ! gh run watch "$run" -R "$repo" --exit-status --interval 30 >/dev/null; then
    echo "The Linux/Windows build failed (gh run view $run -R $repo --log-failed); the draft stays unpublished." >&2
    exit 1
fi
gh release edit "$tag" -R "$repo" --draft=false --latest
echo "Published $tag"
