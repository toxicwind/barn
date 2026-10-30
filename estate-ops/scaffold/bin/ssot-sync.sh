#!/usr/bin/env bash
# ssot-sync.sh — import this pens' config files into /home/toxic/pens/estate/config/<product>
# as the canonical SSOT (moving real file, symlinking back). Run after adding a
# product/config surface. Delegates to the estate-ops reconciler.
set -u
PENS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SSOT_SCRIPT="${SSOT_SCRIPT:-$PENS_ROOT/estate/products/estate-ops/ssot-scaffold.sh}"
if [ -x "$SSOT_SCRIPT" ]; then
  exec "$SSOT_SCRIPT" --apply
else
  echo "ssot-scaffold.sh not found at $SSOT_SCRIPT" >&2
  exit 1
fi
