#!/usr/bin/env bash
set -euo pipefail
SECRETS="${1:-$HOME/.secrets}"
if [[ -z "${BW_SESSION:-}" ]]; then
  echo "BW_SESSION not set. Run: export BW_SESSION=$(bw unlock --raw)" >&2
  exit 1
fi
count=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  [[ -z "$val" ]] && continue
  bw create item --session "$BW_SESSION" --name "$key" --notes "$val" --type 2 >/dev/null 2>&1 || echo "fail: $key"
  count=$((count+1))
done < "$SECRETS"
echo "imported $count items"
