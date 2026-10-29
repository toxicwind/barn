#!/usr/bin/env bash
set -euo pipefail

KEY="$(grep -E '^NVIDIA_API_KEY=' /home/toxic/.9router/env.systemd | head -1 | cut -d= -f2-)"
BEARER="$(grep -E '^API_KEY_SECRET=' /home/toxic/.config/vansrouter/env | cut -d= -f2-)"

for model in \
  "nvidia/nemotron-3-super-120b-a12b" \
  "nvidia/nemotron-3-ultra-550b-a55b" \
  "nvidia/llama-3.3-70b-instruct" \
  "meta/llama-3.1-70b-instruct" \
  "meta/llama-3.1-8b-instruct" \
  "google/gemma-2-9b-it" \
  "mistralai/mistral-7b-instruct-v0.3" \
  ; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:25237/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $BEARER" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":3,\"stream\":false}" \
    --max-time 20 2>/dev/null || echo "ERR")"
  case "$code" in
    200) printf '  ✓ %-45s 200\n' "$model" ;;
    404) printf '  ✗ %-45s 404 (no permission)\n' "$model" ;;
    *)   printf '  ? %-45s %s\n' "$model" "$code" ;;
  esac
done
