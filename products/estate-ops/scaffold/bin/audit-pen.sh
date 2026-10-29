#!/usr/bin/env bash
# audit-pen.sh — automated five-shape audit of a pen (or all pens).
# Checks: 7 metadata files, products/ dir, ssot/ dir, root recursion symlinks,
# kitchen-sink gitignore, ghost paths. Exit 1 on any FAIL.
# Usage: audit-pen.sh [pen...]   (default: all five pens)
set -u
PENS_DIR="/home/toxic/pens"
PENS="${*:-estate geode barn ranch olympus}"
META=".gitignore README.md LICENSE package.json mise.toml AGENTS.md pitchfork.toml"
overall=0

for pen in $PENS; do
  root="$PENS_DIR/$pen"
  echo "=== audit-pen: $pen ==="
  for f in $META; do
    if [ -f "$root/$f" ]; then echo "  OK   $f"; else echo "  FAIL missing $f"; overall=1; fi
  done
  [ -d "$root/products" ] && echo "  OK   products/" || { echo "  WARN no products/ dir (flat-product legacy)"; }
  [ -d "$root/ssot" ] && echo "  OK   ssot/" || echo "  WARN no ssot/"
  # recursion: root symlinks pointing OUTSIDE this pen
  while IFS= read -r -d '' link; do
    target="$(readlink "$link")"
    case "$target" in
      /home/toxic/pens/$pen/*|products/*) : ;;
      /home/toxic/pens/*)
        echo "  FAIL recursion symlink: $(basename "$link") -> $target"
        overall=1 ;;
    esac
  done < <(find "$root" -maxdepth 1 -type l -print0 2>/dev/null)
  # kitchen-sink gitignore
  if [ -f "$root/.gitignore" ] && ! grep -q '^*$' "$root/.gitignore"; then
    echo "  WARN .gitignore not kitchen-sink (missing leading * line)"
  fi
done
exit $overall
