#!/usr/bin/env bash
set -uo pipefail

KEY="$(grep -E '^NVIDIA_API_KEY=' /home/toxic/.9router/env.systemd | head -1 | cut -d= -f2-)"
NIM=https://integrate.api.nvidia.com/v1

echo "=== 1. All 82 models from /models ==="
curl -s -H "Authorization: Bearer $KEY" "$NIM/models" --max-time 10 \
  | jq -r '(.data // .)[] | "\(.id)\t\(.owned_by // "?")"' \
  > /tmp/nim-models.tsv
wc -l /tmp/nim-models.tsv
echo
cat /tmp/nim-models.tsv

echo
echo "=== 2. Testing each model with a 1-token chat ==="
echo
printf '%-55s %-6s %s\n' "MODEL" "CODE" "STATUS"
echo "───────────────────────────────────────────────────────────────────────"

: > /tmp/nim-status.tsv
while IFS=$'\t' read -r model owner; do
  [ -z "$model" ] && continue
  resp="$(curl -s -w '\n%{http_code}' -X POST "$NIM/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1,\"stream\":false}" \
    --max-time 20 2>/dev/null)"
  code="$(echo "$resp" | tail -1)"
  body="$(echo "$resp" | head -n -1)"

  case "$code" in
    200)
      status="OK"
      printf '%-55s %-6s %s\n' "$model" "$code" "$status"
      ;;
    410)
      detail="$(echo "$body" | jq -r '.detail // "EOL"' 2>/dev/null | cut -c1-60)"
      status="EOL: $detail"
      printf '%-55s %-6s %s\n' "$model" "$code" "GONE — $detail"
      ;;
    404)
      status="not found"
      printf '%-55s %-6s %s\n' "$model" "$code" "404"
      ;;
    401|403)
      status="denied"
      printf '%-55s %-6s %s\n' "$model" "$code" "denied"
      ;;
    429)
      status="rate-limited"
      printf '%-55s %-6s %s\n' "$model" "$code" "rate-limited"
      ;;
    5*)
      status="server-error"
      printf '%-55s %-6s %s\n' "$model" "$code" "$(echo "$body" | jq -r '.detail // .error.message // "5xx"' 2>/dev/null | cut -c1-50)"
      ;;
    *)
      status="unknown"
      printf '%-55s %-6s %s\n' "$model" "$code" "$(echo "$body" | cut -c1-60)"
      ;;
  esac
  printf '%s\t%s\t%s\n' "$model" "$code" "$status" >> /tmp/nim-status.tsv
done < /tmp/nim-models.tsv

echo
echo "=== 3. Summary ==="
echo
echo "  by code:"
awk -F'\t' '{print $2}' /tmp/nim-status.tsv | sort | uniq -c | sort -rn | sed 's/^/    /'

echo
echo "  WORKING MODELS (200):"
awk -F'\t' '$2=="200"{print "    ✓ "$1}' /tmp/nim-status.tsv

echo
echo "  EOL/RETIRED (410):"
awk -F'\t' '$2=="410"{print "    ✗ "$1}' /tmp/nim-status.tsv | head -20

echo
echo "  → paste this whole output"
