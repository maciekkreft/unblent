#!/bin/bash
# Builds Unblent.dmg on a Mac with Apple Silicon, the same way the release workflow
# does, without GitHub and without the update signing key: the app is signed ad hoc
# and carries no update files. Whatever is missing (Python 3.14, Rust, the Tauri
# command line) is installed with Homebrew.
#
#   bash build-local.sh [folder holding the unpacked source]
#
# Everything it prints also goes to build-local.log next to this script, so the log can
# be sent back as it is. Written for the bash 3.2 that macOS ships.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
log="$here/build-local.log"
exec > >(tee "$log") 2>&1
trap 'echo; echo "FAILED at line $LINENO. Send back $log."' ERR

if [ $# -gt 0 ]; then
  repo="$(cd "$1" && pwd)"
elif [ -f "$here/freeze.sh" ]; then
  repo="$(cd "$here/.." && pwd)"
else
  echo "Name the folder holding the unpacked source: bash $0 ~/unblent-mac-5"
  exit 1
fi
if [ ! -f "$repo/mac/freeze.sh" ]; then
  echo "$repo does not hold the source (no mac/freeze.sh there)."
  exit 1
fi

echo "== Unblent local build, $(date)"
echo "source: $repo"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "This builds the app for a Mac with Apple Silicon and must run on one."
  exit 1
fi
sw_vers

echo "== Tools"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  echo "Install Apple's command line tools in the window that opened, then run this again."
  exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  else
    echo "Homebrew is missing. Install it from https://brew.sh, then run this again."
    exit 1
  fi
fi

brew list --versions python@3.14 >/dev/null 2>&1 || brew install python@3.14
python="$(brew --prefix python@3.14)/bin/python3.14"

export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null 2>&1 || brew install rust
cargo tauri --version >/dev/null 2>&1 || cargo install tauri-cli --version "^2" --locked

"$python" --version
cargo --version
cargo tauri --version

echo "== Packaging the server"
PYTHON="$python" bash "$repo/mac/freeze.sh"

echo "== Building the app"
# The update files need the private signing key, which only the release workflow has.
cd "$repo/mac/src-tauri"
cargo tauri build --target aarch64-apple-darwin \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

bundle="$repo/mac/src-tauri/target/aarch64-apple-darwin/release/bundle"
app="$bundle/macos/Unblent.app"
echo "== Checking the signature"
codesign --verify --deep --strict --verbose=2 "$app" || echo "The signature check above failed."
codesign -dv "$app" 2>&1 | grep -E "Identifier|Signature|Format" || true

dmg="$repo/mac/build/Unblent.dmg"
for made in "$bundle"/dmg/*.dmg; do cp "$made" "$dmg"; done
echo
echo "Done: $dmg ($(du -h "$dmg" | cut -f1))"
