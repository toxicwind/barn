#!/usr/bin/env bash
# coverage_gate.sh — coverage gate for thresher's ESTATE-owned packages.
#
# Scope: the packages that carry estate code (our fork's deltas) plus the
# packages whose behavior we own operationally. Upstream's remaining
# packages are upstream's responsibility — we track them in docs/COVERAGE.md
# but do not gate on them.
#
# Usage: bash tests/coverage_gate.sh [threshold]     (default threshold 95)
set -uo pipefail

THRESHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${THRESHER_DIR}/vendor"
THRESHOLD="${1:-95}"
PROFILE="${VENDOR}/coverage-estate.out"

# Estate-owned packages: the ones holding our carried files plus the
# operational surface we gate on (secrets cmd lives in cmd/mcpproxy).
PACKAGES=(
  ./cmd/mcpproxy
  ./internal/config
  ./internal/contracts
  ./internal/httpapi
)

cd "${VENDOR}" || { echo "FAIL: no vendor dir at ${VENDOR}"; exit 1; }

echo "== running estate coverage (threshold ${THRESHOLD}%) =="
if ! go test -count=1 -coverprofile="${PROFILE}" "${PACKAGES[@]}"; then
  echo "FAIL: estate package tests failed"
  exit 1
fi

# Per-package coverage from the profile
TOTAL_STMT=0
COVERED_STMT=0
FAILED=0
printf '%-46s %8s %8s %8s\n' PACKAGE STMT COVER PCT
for pkg in "${PACKAGES[@]}"; do
  line=$(go tool cover -func="${PROFILE}" 2>/dev/null | grep -F "${pkg#./}" | awk '
    { stmts += $2; if ($3 > 0) cov += $2 }
    END { if (stmts > 0) printf "%d %d %.1f", stmts, cov, (cov/stmts)*100; else printf "0 0 0.0" }')
  read -r stmts cov pct <<<"${line}"
  TOTAL_STMT=$((TOTAL_STMT + stmts))
  COVERED_STMT=$((COVERED_STMT + cov))
  printf '%-46s %8s %8s %7s%%\n' "${pkg}" "${stmts}" "${cov}" "${pct}"
  if awk "BEGIN {exit !(${pct} >= ${THRESHOLD})}"; then
    :
  else
    echo "  -> below threshold (${pct}% < ${THRESHOLD}%)"
    FAILED=1
  fi
done

if [ "${TOTAL_STMT}" -gt 0 ]; then
  TOTAL_PCT=$(awk "BEGIN {printf \"%.1f\", (${COVERED_STMT}/${TOTAL_STMT})*100}")
else
  TOTAL_PCT=0
fi
printf '\nTOTAL: %d/%d statements = %s%% (threshold %s%%)\n' \
  "${COVERED_STMT}" "${TOTAL_STMT}" "${TOTAL_PCT}" "${THRESHOLD}"

if [ "${FAILED}" -ne 0 ]; then
  echo "FAIL: estate coverage below ${THRESHOLD}%"
  exit 1
fi
echo "PASS: estate coverage >= ${THRESHOLD}%"
