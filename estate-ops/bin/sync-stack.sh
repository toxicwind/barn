#!/usr/bin/env bash
# sync-stack.sh — keep the pens/estate namespace's stack/ in sync with the
# estate clone's stack/ (the SSOT).
#
# WHY THIS EXISTS: the estate clone (/home/toxic/estate) is the tracked
# source of truth for pitchfork.toml, config/, and stack/. The supervisor
# loads pitchfork.toml from the NAMESPACE pen (/home/toxic/pens/estate per
# ~/.config/pitchfork/config.toml), and daemon scripts run with
# `dir = "/home/toxic/pens/estate"` — so they resolve ./stack/... against
# the PEN, not the clone. When the two drift, daemons fail with
# "No such file or directory" on lib-ports.sh / their own scripts (hindsight
# failed 80+ times this way: SOV pointed at the pen whose stack/ lacked
# lib-ports.sh).
#
# Contract:
#   - clone stack/  = SSOT (tracked in git at wip/tau/continue-session)
#   - pen stack/    = runtime mirror, re-synced by this script
#   - any file in the pen's stack/ that does not exist in the clone is a
#     stale artifact and is REMOVED (mirror semantics, logged).
#
# Run: after committing to the clone, before restarting affected daemons.
# Called by: sync-estate-ns.sh (also runs lib-ports.sh-dependent checks).

set -euo pipefail

CLONE="${ESTATE_ROOT:-/home/toxic/estate}"
PEN="${PENS_ESTATE:-/home/toxic/pens/estate}"

SRC="$CLONE/stack"
DST="$PEN/stack"

[[ -d "$SRC" ]] || { echo "sync-stack: no $SRC" >&2; exit 1; }

mkdir -p "$DST"

# Mirror: add/update everything from the clone, delete stale pen-only files.
added=0 updated=0 removed=0

while IFS= read -r -d '' src; do
	rel="${src#"$SRC"/}"
	dst="$DST/$rel"
	mkdir -p "$(dirname "$dst")"
	if [[ ! -f "$dst" ]]; then
		cp "$src" "$dst"
		echo "  + $rel"
		added=$((added + 1))
	elif ! cmp -s "$src" "$dst"; then
		cp "$src" "$dst"
		echo "  ~ $rel"
		updated=$((updated + 1))
	fi
done < <(find "$SRC" -type f -print0)

while IFS= read -r -d '' dst; do
	rel="${dst#"$DST"/}"
	if [[ ! -f "$SRC/$rel" ]]; then
		rm -f "$dst"
		echo "  - $rel (stale)"
		removed=$((removed + 1))
	fi
done < <(find "$DST" -type f -print0)

echo "sync-stack: clone=$SRC -> pen=$DST  (+$added ~$updated -$removed)"

# Sanity: every lib-ports consumer in the clone resolves in the pen.
fail=0
while IFS= read -r script; do
	if grep -q 'stack/lib-ports.sh' "$script" 2>/dev/null; then
		[[ -f "$PEN/stack/lib-ports.sh" ]] || { echo "sync-stack: MISSING lib-ports.sh" >&2; fail=1; }
		break
	fi
done < <(find "$SRC/services" -name "*.sh" 2>/dev/null)
[[ $fail -eq 0 ]] || exit 1
