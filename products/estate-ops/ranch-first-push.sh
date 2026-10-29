#!/usr/bin/env bash
# ranch-first — push the ranch peers, then the estate control plane.
#
# Estate doctrine: "Git push everything" — but the ranch (214+ peers, meta-managed)
# must go first so no peer is left local-only before the estate index moves.
#
# Usage:
#   bin/ranch-first-push.sh            # push ranch (parallel) then estate
#   bin/ranch-first-push.sh --dry-run  # show what would run, change nothing
#   bin/ranch-first-push.sh --ranch    # ranch peers only
#   bin/ranch-first-push.sh --estate   # estate control-plane only
#
# Options feed through to `meta exec` for ranch pushes. Never force-pushes.

set -euo pipefail

ESTATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RANCH_ROOT="$ESTATE_ROOT/ranch"
META="$(command -v meta || echo "$HOME/.local/bin/meta")"
DRY=""
MODE="both"

for a in "$@"; do
  case "$a" in
    --dry-run) DRY="--dry-run" ;;
    --ranch)   MODE="ranch" ;;
    --estate)  MODE="estate" ;;
  esac
done

push_ranch() {
  echo "== ranch-first: pushing ranch peers (ele -> ranch) =="
  # shellcheck disable=SC2086
  ( cd "$RANCH_ROOT" && "$META" exec $DRY --parallel -- git push )
}

push_estate() {
  echo "== estate control-plane push =="
  if [ -n "$DRY" ]; then
    echo "(dry-run) would push $ESTATE_ROOT"
    return 0
  fi
  git -C "$ESTATE_ROOT" push
}

case "$MODE" in
  ranch)  push_ranch ;;
  estate) push_estate ;;
  both)   push_ranch && push_estate ;;
esac