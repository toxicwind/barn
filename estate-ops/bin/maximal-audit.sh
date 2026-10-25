#!/usr/bin/env bash
# maximal-audit.sh — periodic agentic audit over all estate projects.
# Mirrors bin-contract-audit.sh: a batch canary that runs once, reports via
# exit code, and goes unhealthy (thus pages) when it fails.
# Runs `src/index.ts --all --precheck --parquet` inside the maximal audit tree.
set -uo pipefail
ESTATE="${ESTATE_ROOT:-/home/toxic/estate}"
MAX="${MAXIMAL_AUDIT_DIR:-$ESTATE/src/maximal-estate-agentic-audit}"
OUT="${MAXIMAL_AUDIT_OUTPUT:-$ESTATE/var/log/maximal-audit}"
mkdir -p "$OUT"
set +u
if ! command -v bun >/dev/null 2>&1; then
  echo "[maximal-audit] bun not on PATH" >&2
  exit 1
fi
set -u
echo "[maximal-audit] $(date -Is) — auditing all estate projects"
cd "$MAX" || { echo "[maximal-audit] cd failed: $MAX" >&2; exit 1; }
LOG="$OUT/latest.log"
if bun run start --all --precheck --parquet "$OUT/repo-audit.parquet" >"$LOG" 2>&1; then
  echo "[maximal-audit] OK — $(tail -3 "$LOG" | grep -E 'Found|completed' | tr '\n' ' ') (see $LOG)"
  exit 0
else
  echo "[maximal-audit] FAIL — see $LOG"
  tail -10 "$LOG" >&2
  exit 1
fi
