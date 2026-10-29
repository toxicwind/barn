#!/usr/bin/env bash
set -euo pipefail

DB=/home/toxic/.9router/db/data.sqlite
ENV_SYSTEMD=/home/toxic/.9router/env.systemd
SRC=/home/toxic/pens/ranch/vansrouter/cli/app
BUILD="$SRC/.next-cli-build"

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }
hdr() { echo -e "\n${C}══ $1 ══${N}"; }

NVIDIA_KEY="$(grep -E '^NVIDIA_API_KEY=' "$ENV_SYSTEMD" | head -1 | cut -d= -f2-)"
NVIDIA_POOL="$(grep -E '^NVIDIA_API_KEYS=' "$ENV_SYSTEMD" | head -1 | cut -d= -f2-)"
[ -n "$NVIDIA_KEY" ] || { bad "no key"; exit 1; }

# ─────────────────────────────────────────────────────────────────
hdr "1. How source reads providerConnections.data"

# Search compiled server for the exact field names it expects
FOUND_SHAPE=""
for js in $(find "$BUILD/server" -name '*.js' -type f 2>/dev/null); do
  if grep -q 'providerConnections' "$js" 2>/dev/null; then
    echo "  file: $js"
    grep -oE 'providerConnections[^;]{0,400}' "$js" 2>/dev/null | head -3 | sed 's/^/    /'
    FOUND_SHAPE="$js"
  fi
done | head -30

[ -z "$FOUND_SHAPE" ] && echo "  (providerConnections not referenced in compiled JS)"

# ─────────────────────────────────────────────────────────────────
hdr "2. Search for how 'opencode' Public account resolves"

find "$BUILD" -name '*.js' -type f 2>/dev/null | while read -r js; do
  if grep -q 'opencode' "$js" 2>/dev/null; then
    grep -oE '"opencode"[^;]{0,200}' "$js" 2>/dev/null | head -2
  fi
done | head -10

# ─────────────────────────────────────────────────────────────────
hdr "3. Search for 'nvidia' provider definition in source"

find "$BUILD" -name '*.js' -type f 2>/dev/null | while read -r js; do
  if grep -q 'nvidia' "$js" 2>/dev/null; then
    grep -oE 'nvidia[^;]{0,300}' "$js" 2>/dev/null | head -3 | sed "s|^|  [$(basename "$js")] |"
  fi
done | head -20

# ─────────────────────────────────────────────────────────────────
hdr "4. Search source (TS) for provider registry / credential shape"

find "$SRC" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' \) \
  -not -path '*/node_modules/*' -not -path '*/.next*' 2>/dev/null | while read -r f; do
  if grep -ql 'providerConnections\|authType\|credential' "$f" 2>/dev/null; then
    echo "  $f"
  fi
done | head -20

# ─────────────────────────────────────────────────────────────────
hdr "5. Grep for authType values used anywhere"

find "$BUILD" -name '*.js' -type f 2>/dev/null -exec grep -ohE 'authType[":= ]+[a-z_]+' {} \; 2>/dev/null | sort -u | head -10

# ─────────────────────────────────────────────────────────────────
hdr "6. Look for a 'data' JSON shape example — grep for apiKey in JS"

find "$BUILD" -name '*.js' -type f 2>/dev/null -exec grep -ohE '(apiKey|api_key|bearer|token)[":,\s]+[a-z_]{2,30}' {} \; 2>/dev/null | sort -u | head -20

# ─────────────────────────────────────────────────────────────────
hdr "7. Insert nvidia providerConnections row (multiple shape candidates)"

# Try each candidate shape; report which one parses back

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

try_insert() {
  local label="$1" id="$2" data_json="$3"
  sqlite3 "$DB" "DELETE FROM providerConnections WHERE id='$id';" 2>/dev/null || true
  if sqlite3 "$DB" "INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES ('$id', 'nvidia', 'apiKey', 'Personal', NULL, 1, 1, '$data_json', '$NOW', '$NOW');" 2>/dev/null; then
    ok "inserted shape: $label"
    return 0
  else
    bad "shape $label failed"
    return 1
  fi
}

# Shape A: bare apiKey
try_insert "A:{apiKey}" "nvidia-personal" "{\"apiKey\":\"$NVIDIA_KEY\"}" || true

# ─────────────────────────────────────────────────────────────────
hdr "8. Verify row parses"

sqlite3 -json "$DB" "SELECT id, provider, authType, name, isActive, data FROM providerConnections WHERE provider='nvidia';" 2>/dev/null | jq . | head -20

# ─────────────────────────────────────────────────────────────────
hdr "9. Also insert into providerNodes for pool"

sqlite3 "$DB" "DELETE FROM providerNodes WHERE id='nvidia-pool';" 2>/dev/null || true
POOL_JSON="{\"apiKeys\":[$(echo "$NVIDIA_POOL" | sed 's/,/","/g' | sed 's/^/"/;s/$/"/')]}"
sqlite3 "$DB" "INSERT INTO providerNodes (id, type, name, data, createdAt, updatedAt) VALUES ('nvidia-pool', 'pool', 'NVIDIA Pool', '$POOL_JSON', '$NOW', '$NOW');" 2>/dev/null && ok "inserted pool node" || bad "pool node failed"

# ─────────────────────────────────────────────────────────────────
hdr "10. Restart vansrouter + probe"

cd /home/toxic/estate
pitchfork clean --daemon estate/vansrouter 2>&1 | tail -1 || true
pitchfork restart estate/vansrouter 2>&1 | tail -5 || true
sleep 4

echo
echo "  probing nvidia chat..."
resp="$(curl -s -X POST "http://127.0.0.1:20128/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(grep -E '^API_KEY_SECRET=' /home/toxic/.config/vansrouter/env | cut -d= -f2-)" \
  -d '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"say hi"}],"max_tokens":5,"stream":false}' \
  --max-time 45 2>/dev/null)"

if echo "$resp" | grep -q '"choices"'; then
  ok "NVIDIA WORKS"
  echo "$resp" | jq -r '.choices[0].message.content // .' 2>/dev/null | head -3 | sed 's/^/    /'
else
  bad "still failing"
  echo "    $resp" | head -c 300
  echo
  echo "  log tail:"
  pitchfork logs estate/vansrouter --raw -n 40 --no-pager 2>&1 | grep -E 'nvidia|AUTH|PENDING|ERROR' | tail -15 | sed 's/^/    /'
fi

echo
hdr "DONE"
