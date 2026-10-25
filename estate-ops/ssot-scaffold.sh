#!/usr/bin/env bash
# ssot-scaffold — GLOBAL SSOT consolidation across all pens products.
#
# Every pens product should feed its config into /home/toxic/estate/config/<product>
# as the canonical SSOT, with the product's on-disk config a SYMLINK to it (import,
# never a duplicate). This is the "one source of truth, daemons import" doctrine.
#
# Run (global patch):  bash ssot-scaffold.sh --apply
# Dry-run:             bash ssot-scaffold.sh
# Reconcile pass:      bash ssot-scaffold.sh --verify  (exit 3 = a product's config is
#                       a real file, not a symlink -> a duplicate to reconcile)
set -u

SSOT_ROOT=/home/toxic/estate/config
PRODUCTS="barn olympos ranch"   # pens/{barn,olympus,ranch}
VERBOSE=0
[ "${1:-}" = "--apply" ] && APPLY=1 || APPLY=0
[ "${1:-}" = "--verify" ] && VERIFY=1 || VERIFY=0
[ "${1:-}" = "-v" ] && VERBOSE=1

declare -i dupe=0

for pen in $PRODUCTS; do
  for dir in /home/toxic/pens/"$pen"/*; do
    [ -d "$dir" ] || continue
    prod=$(basename "$dir")
    # Skip internal/".git"/"node_modules" namespace dnd, and products with no config surface.
    case "$prod" in .git|node_modules|.cache|.|bun-scaffold) continue;; esac
    # candidate SSOT config files a product commonly owns
    for cfg in mcp_config.json herd.yaml models.json models.yml config.json config.yml workspace.json; do
      found=$(find "$dir" -maxdepth 2 -name "$cfg" 2>/dev/null | grep -v node_modules | head -1)
      [ -n "$found" ] || continue
      ssot="$SSOT_ROOT/$prod"
      mkdir -p "$ssot"
      target="$ssot/$cfg"
      if [ "$found" != "$target" ]; then
        if [ "$APPLY" = 1 ]; then
          # move real file into SSOT, symlink back (import semantics)
          if [ -L "$found" ]; then
            [ "$VERBOSE" = 1 ] && echo "OK  $found -> $(readlink "$found") (already symlink)"
            continue
          fi
          mv -v "$found" "$target" 2>/dev/null
          ln -sfn "$target" "$found" 2>/dev/null
          dupe+=1
          echo "SSOT  $found -> $target"
        else
          if [ ! -L "$found" ]; then
            echo "DUP  $found (real file; would move to $target + symlink)"
            dupe+=1
          else
            [ "$VERBOSE" = 1 ] && echo "OK   $found -> $(readlink "$found")"
          fi
        fi
      fi
    done
  done
done

if [ "${VERIFY:-0}" = 1 ]; then
  echo "[verify] products with a duplicate (non-symlink) config still to reconcile: $dupe"
  [ "$dupe" -gt 0 ] && exit 3 || exit 0
fi
echo "ssot-scaffold: $dupe configs to reconcile (apply with --apply)."
exit 0