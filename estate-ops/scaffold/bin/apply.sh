#!/usr/bin/env bash
# scaffold apply.sh — bring an existing pen repo into the thin-coordinator scaffold.
# MAXIMALLY NON-DESTRUCTIVE: dry-run by default (prints what it would do, moves nothing).
# Use --apply to execute; moves only, never deletes; archives litter inside the pen;
# git-stashes WIP before every move so nothing is ever lost.
#
# Usage: apply.sh <pen-name>                 (dry-run, safe to re-run)
#        apply.sh <pen-name> --apply          (execute moves)
#        apply.sh --pen /home/toxic/pens/X    (explicit pen dir; dry-run)
set -euo pipefail
PEN=""
PEN_DIR=""
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --pen) shift; PEN_DIR="$1"; shift ;;
    --pen=*) PEN_DIR="${1#*=}"; shift ;;
    --dry-run) shift ;;
    *) PEN="${1:-}"; shift ;;
  esac
done
if [ -z "$PEN_DIR" ]; then PEN_DIR="/home/toxic/pens/${PEN}"; fi
if [ ! -d "$PEN_DIR" ]; then
  echo "pen dir not found: $PEN_DIR" >&2; exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin"
REORG="$BIN/reorganize-pen.ts"
if [ ! -f "$REORG" ]; then
  echo "reorganize-pen.ts not found: $REORG" >&2; exit 2
fi
PEN_NAME="$(basename "$PEN_DIR")"
echo "==> scaffold apply for pen $PEN_NAME at $PEN_DIR"
if [ "$APPLY" = "1" ]; then
  echo "==> EXECUTING (moves only — nothing is deleted)"
  bun run "$REORG" "$PEN_NAME" --apply
else
  echo "==> DRY-RUN (no changes) — pass --apply to execute"
  bun run "$REORG" "$PEN_NAME"
fi
echo "==> post-move audit:"
"$BIN/audit-pen.sh" "$PEN_NAME" || echo "audit reported issues above (non-fatal)"
