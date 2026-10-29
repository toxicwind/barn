#!/usr/bin/env bash
set -uo pipefail

ENV_FILE=/home/toxic/.9router/env.systemd

# Extract all keys
SINGLE="$(grep -E '^NVIDIA_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
NIM_KEY="$(grep -E '^NVIDIA_NIM_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POOL_RAW="$(grep -E '^NVIDIA_API_KEYS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"

declare -a KEYS=()
[ -n "$SINGLE" ] && KEYS+=("nvapi_primary:$SINGLE")
[ -n "$NIM_KEY" ] && KEYS+=("npk_nim:$NIM_KEY")
i=0
for k in ${POOL_RAW//,/ }; do
  [ -n "$k" ] && KEYS+=("nvapi_pool_$i:$k")
  i=$(( i + 1 ))
done

echo "=== KEY INVENTORY ==="
for entry in "${KEYS[@]}"; do
  name="${entry%%:*}"
  key="${entry#*:}"
  printf '  %-18s  %s...%s  (len %d)\n' "$name" "${key:0:12}" "${key: -6}" "${#key}"
done

echo
echo "=== DIRECT NIM TEST — integrate.api.nvidia.com ==="
echo

# Test models endpoint first (cheap, tells us if key is accepted at all)
for entry in "${KEYS[@]}"; do
  name="${entry%%:*}"
  key="${entry#*:}"

  # GET /models
  code_models="$(curl -s -o /tmp/nim-models.json -w '%{http_code}' \
    -H "Authorization: Bearer $key" \
    "https://integrate.api.nvidia.com/v1/models" --max-time 10)"

  # POST /chat/completions with a very safe model (llama 8b is usually open)
  code_chat="$(curl -s -o /tmp/nim-chat.json -w '%{http_code}' \
    -X POST "https://integrate.api.nvidia.com/v1/chat/completions" \
    -H "Authorization: Bearer $key" \
    -H 'Content-Type: application/json' \
    -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"hi"}],"max_tokens":3,"stream":false}' \
    --max-time 20)"

  printf '  %-18s  GET /models=%s  POST /chat=%s\n' "$name" "$code_models" "$code_chat"

  # show the error body if chat failed
  if [ "$code_chat" != "200" ]; then
    body="$(head -c 200 /tmp/nim-chat.json 2>/dev/null | tr -d '\n')"
    [ -n "$body" ] && printf '      → %s\n' "$body"
  fi
done

echo
echo "=== ALTERNATE ENDPOINTS (same key) ==="

KEY="$SINGLE"
[ -z "$KEY" ] && KEY="$NIM_KEY"

for endpoint in \
  "https://integrate.api.nvidia.com/v1/chat/completions" \
  "https://api.nvcf.nvidia.com/v2/nvcf/pexec/functions" \
  "https://ai.api.nvidia.com/v1/chat/completions" \
  ; do
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$endpoint" \
    -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' \
    -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"hi"}],"max_tokens":3}' \
    --max-time 15)"
  printf '  %-55s %s\n' "$endpoint" "$code"
done

echo
echo "=== WHAT /models ACTUALLY LISTS for a working key ==="
for entry in "${KEYS[@]}"; do
  name="${entry%%:*}"
  key="${entry#*:}"
  n="$(curl -s -H "Authorization: Bearer $key" \
    "https://integrate.api.nvidia.com/v1/models" --max-time 10 2>/dev/null \
    | jq -r '(.data // .) | length' 2>/dev/null || echo 0)"
  printf '  %-18s  %s models visible\n' "$name" "$n"
done

echo
echo "DONE"
