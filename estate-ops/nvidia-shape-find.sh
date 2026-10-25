#!/usr/bin/env bash
set -euo pipefail

DB=/home/toxic/.9router/db/data.sqlite
ENV_SYSTEMD=/home/toxic/.9router/env.systemd
BUILD=/home/toxic/pens/ranch/vansrouter/cli/app/.next-cli-build

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }
hdr() { echo -e "\n${C}══ $1 ══${N}"; }

NVIDIA_KEY="$(grep -E '^NVIDIA_API_KEY=' "$ENV_SYSTEMD" | head -1 | cut -d= -f2-)"
[ -n "$NVIDIA_KEY" ] || { bad "no key"; exit 1; }

# ─────────────────────────────────────────────────────────────────
hdr "1. The exact authType values in use"

grep -rohE 'authType[^,;]{0,80}' "$BUILD" 2>/dev/null | sort -u | head -20

# ─────────────────────────────────────────────────────────────────
hdr "2. Where 'apiKey' / 'apiKeys' / 'credentials' / 'accessToken' are read"

for term in 'apiKey' 'apiKeys' 'credentials' 'accessToken' 'oauth'; do
  echo "── $term ──"
  grep -rohE "\.${term}\b[^,;)}]{0,60}" "$BUILD" 2>/dev/null | sort -u | head -5
done

# ─────────────────────────────────────────────────────────────────
hdr "3. How opencode 'Public' resolves — where is it defined"

grep -rohE 'opencode[^,;]{0,120}' "$BUILD" 2>/dev/null | sort -u | head -15

# ─────────────────────────────────────────────────────────────────
hdr "4. Provider registry / default accounts"

# Look for a providers.ts or similar
find "$BUILD" -name '*.js' -type f 2>/dev/null | while read -r js; do
  if grep -q 'nvidia' "$js" 2>/dev/null && grep -q 'baseUrl\|endpoint\|apiKey' "$js" 2>/dev/null; then
    echo "  $js"
    grep -oE "nvidia[^,;]{0,200}" "$js" 2>/dev/null | head -3 | sed 's/^/    /'
  fi
done | head -30

# ─────────────────────────────────────────────────────────────────
hdr "5. Search for integration.api.nvidia.com base URL"

grep -rl 'integrate.api.nvidia.com' "$BUILD" 2>/dev/null | head -5
grep -rohE 'https://integrate\.api\.nvidia\.com[^"'\'']{0,40}' "$BUILD" 2>/dev/null | sort -u | head -5

# ─────────────────────────────────────────────────────────────────
hdr "6. Look for 'authType' paired with a data shape (both in same line)"

grep -rohE "authType[^;]{0,50}(apiKey|oauth|bearer)[^;]{0,200}" "$BUILD" 2>/dev/null | sort -u | head -10

# ─────────────────────────────────────────────────────────────────
hdr "7. Decisive insert — try shape guesses, keep the one that works"

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

wipe() { sqlite3 "$DB" "DELETE FROM providerConnections WHERE provider='nvidia';" 2>/dev/null || true; }

insert() {
  local label="$1" data="$2"
  wipe
  sqlite3 "$DB" "INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
    VALUES ('nvidia-personal', 'nvidia', 'apiKey', 'Personal', NULL, 1, 1, '$data', '$NOW', '$NOW');" 2>/dev/null
  if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM providerConnections WHERE provider='nvidia';" 2>/dev/null)" = "1" ]; then
    ok "inserted: $label"
    return 0
  fi
  bad "failed: $label"
  return 1
}

#  Try several candidate shapes
insert "A {apiKey}"            "{\"apiKey\":\"$NVIDIA_KEY\"}"
insert "B {apiKeys:[k]}"       "{\"apiKeys\":[\"$NVIDIA_KEY\"]}"
insert "C {credentials:{apiKey}}" "{\"credentials\":{\"apiKey\":\"$NVIDIA_KEY\"}}"
insert "D {accessToken}"       "{\"accessToken\":\"$NVIDIA_KEY\"}"
insert "E {key}"               "{\"key\":\"$NVIDIA_KEY\"}"

# leave A in place as the most likely
insert "FINAL {apiKey}"        "{\"apiKey\":\"$NVIDIA_KEY\"}"

# ─────────────────────────────────────────────────────────────────
hdr "8. Restart + probe with each shape — find which one clears AUTH"

probe() {
  local label="$1"
  cd /home/toxic/estate
  pitchfork clean --daemon estate/vansrouter 2>&1 >/dev/null || true
  pitchfork restart estate/vansrouter 2>&1 >/dev/null || true
  sleep 4

  local resp
  resp="$(curl -s -X POST "http://127.0.0.1:20128/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $(grep -E '^API_KEY_SECRET=' /home/toxic/.config/vansrouter/env | cut -d= -f2-)" \
    -d '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"hi"}],"max_tokens":3,"stream":false}' \
    --max-time 45 2>/dev/null)"

  if echo "$resp" | grep -q '"choices"'; then
    echo "  ${G}✓ $label WORKS${N}"
    echo "$resp" | jq -r '.choices[0].message.content' 2>/dev/null | head -2 | sed 's/^/      /'
    return 0
  else
    local short
    short="$(echo "$resp" | grep -oE '"message":"[^"]*"' | head -1)"
    echo "  ${R}✗${N} $label — $short"
    return 1
  fi
}

for shape in \
  'A|{"apiKey":"'"$NVIDIA_KEY"'"}' \
  'B|{"apiKeys":["'"$NVIDIA_KEY"'"]}' \
  'C|{"credentials":{"apiKey":"'"$NVIDIA_KEY"'"}}' \
  'D|{"accessToken":"'"$NVIDIA_KEY"'"}' \
  ; do
  name="${shape%%|*}"
  data="${shape#*|}"
  wipe
  sqlite3 "$DB" "INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
    VALUES ('nvidia-personal', 'nvidia', 'apiKey', 'Personal', NULL, 1, 1, '$data', '$NOW', '$NOW');" 2>/dev/null
  probe "$name" && break
done

hdr "DONE"
