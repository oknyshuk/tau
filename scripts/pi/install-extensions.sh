#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${PI_EXT_DIR:-$HOME/.pi/agent/extensions}"
MODE="symlink"

usage() {
  cat <<EOF
Usage: $0 [--copy]

Installs tau pi extension packages into the global pi extensions directory.

Default: creates symlinks in: ~/.pi/agent/extensions

Options:
  --copy   Copy directories instead of symlinking

Override target with:
  PI_EXT_DIR=/path/to/extensions $0
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--copy" ]]; then
  MODE="copy"
fi

mkdir -p "$TARGET"

echo "Installing pi extensions to: $TARGET ($MODE)"

EXTS=(tau)
LEGACY_EXTS=(exa task editor-hub sandbox)

# Clean up legacy extension installs/symlinks from pre-consolidation days.
for ext in "${LEGACY_EXTS[@]}"; do
  rm -rf "$TARGET/$ext"
done

for ext in "${EXTS[@]}"; do
  src="$ROOT/extensions/$ext"
  dst="$TARGET/$ext"

  if [[ ! -e "$src" ]]; then
    echo "[skip] missing: $src"
    continue
  fi

  if [[ "$MODE" == "symlink" ]]; then
    # replace existing dst (file/dir/symlink)
    rm -rf "$dst"
    ln -s "$src" "$dst"
    echo "[ok] linked $ext"
  else
    rm -rf "$dst"
    cp -R "$src" "$dst"
    echo "[ok] copied $ext"
  fi

done

echo "Done. Restart pi and confirm: Loaded extensions"
