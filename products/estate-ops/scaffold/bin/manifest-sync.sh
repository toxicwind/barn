#!/usr/bin/env bash
# manifest-sync.sh — regenerate the estate bin manifest + verify all links.
set -euo pipefail
ESTATE_OPS="${ESTATE_OPS:-/home/toxic/pens/barn/estate-ops}"
python3 "$ESTATE_OPS/bin/manifest-gen.py"
"$ESTATE_OPS/bin-verify.sh"
echo "manifest regenerated + verified: $(grep -c '^  - name:' "$ESTATE_OPS/bin/manifest.yaml") entries"
