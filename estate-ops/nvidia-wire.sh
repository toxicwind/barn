#!/usr/bin/env bash
set -euo pipefail

ENV_SYSTEMD=/home/toxic/.9router/env.systemd
VANS_ENV=/home/toxic/.config/vansrouter/env
DB=/home/toxic/.9router/db/data.sqlite
NVIDIA_MODEL="nvidia/nemotron-3-super-120b-a12b"

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }
inf() { echo -e "  ${Y}ℹ${N} $1"; }

# ─────────────────────────────────────────────────────────────────────
echo "── 1. Extract NVIDIA keys from env.systemd ──"

NVIDIA_KEY="$(grep -E '^NVIDIA_API_KEY=' "$ENV_SYSTEMD" | head -1 | cut -d= -f2-)"
NVIDIA_POOL="$(grep -E '^NVIDIA_API_KEYS=' "$ENV_SYSTEMD" | head -1 | cut -d= -f2-)"

[ -n "$NVIDIA_KEY" ]  && ok "single key: ${NVIDIA_KEY:0:20}...${NVIDIA_KEY: -6}"  || bad "no NVIDIA_API_KEY"
[ -n "$NVIDIA_POOL" ] && ok "pool: $(echo "$NVIDIA_POOL" | tr ',' '\n' | wc -l) keys" || bad "no NVIDIA_API_KEYS"

# ─────────────────────────────────────────────────────────────────────
echo
echo "── 2. Copy into vansrouter's sourced env ──"

[ -f "$VANS_ENV" ] && cp "$VANS_ENV" "$VANS_ENV.bak.$(date +%s)" && ok "backed up $VANS_ENV"

# Idempotent: remove existing NVIDIA_ lines, then append
grep -vE '^NVIDIA_' "$VANS_ENV" > "$VANS_ENV.tmp" 2>/dev/null || : > "$VANS_ENV.tmp"

cat >> "$VANS_ENV.tmp" <<EOF
NVIDIA_API_KEY=$NVIDIA_KEY
NVIDIA_API_KEYS=$NVIDIA_POOL
NVIDIA_NIM_API_KEY=$NVIDIA_KEY
EOF

mv "$VANS_ENV.tmp" "$VANS_ENV"
chmod 600 "$VANS_ENV"
ok "wrote NVIDIA keys to $VANS_ENV (0600)"

# ─────────────────────────────────────────────────────────────────────
echo
echo "── 3. Inspect vansrouter DB schema ──"

if ! command -v sqlite3 >/dev/null 2>&1; then
  bad "sqlite3 not installed — apt install sqlite3"
  exit 1
fi

echo "  tables:"
sqlite3 "$DB" ".tables" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | sed 's/^/    /'

echo
echo "  candidate credential tables:"
for t in accounts provider_accounts connections providers credentials keys api_keys; do
  exists="$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='$t';" 2>/dev/null)"
  [ -n "$exists" ] && echo "    $t: $(sqlite3 "$DB" "SELECT COUNT(*) FROM $t;" 2>/dev/null) rows"
done

# ─────────────────────────────────────────────────────────────────────
echo
echo "── 4. Insert NVIDIA credential into DB ──"

insert_key() {
  local table="$1" key_col="$2" prov_col="$3"
  # Check if nvidia row exists
  local existing
  existing="$(sqlite3 "$DB" "SELECT COUNT(*) FROM $table WHERE $prov_col LIKE '%nvidia%';" 2>/dev/null || echo 0)"

  if [ "$existing" -gt 0 ]; then
    sqlite3 "$DB" "UPDATE $table SET $key_col='$NVIDIA_KEY' WHERE $prov_col LIKE '%nvidia%';" 2>/dev/null
    ok "updated $table.$key_col where $prov_col LIKE nvidia"
  else
    # Try to insert with common columns
    local cols
    cols="$(sqlite3 "$DB" "PRAGMA table_info($table);" 2>/dev/null | cut -d'|' -f2 | tr '\n' ' ')"
    inf "$table columns: $cols"
  fi
}

for table in accounts provider_accounts connections providers credentials; do
  exists="$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='$table';" 2>/dev/null)"
  [ -z "$exists" ] && continue

  # Which key column?
  keycol=""
  for c in apiKey api_key key token secret credentials; do
    if sqlite3 "$DB" "PRAGMA table_info($table);" 2>/dev/null | grep -q "|$c|"; then
      keycol="$c"
      break
    fi
  done

  provcol=""
  for c in provider name id slug type; do
    if sqlite3 "$DB" "PRAGMA table_info($table);" 2>/dev/null | grep -q "|$c|"; then
      provcol="$c"
      break
    fi
  done

  [ -n "$keycol" ] && [ -n "$provcol" ] && insert_key "$table" "$keycol" "$provcol"
done

# ─────────────────────────────────────────────────────────────────────
echo
echo "── 5. Restart vansrouter ──"

cd /home/toxic/estate
pitchfork clean --daemon estate/vansrouter 2>&1 | tail -1 || true
pitchfork restart estate/vansrouter 2>&1 | tail -5 || true
sleep 3

ss -tlnH "( sport = :20128 )" 2>/dev/null | grep -q LISTEN && ok "vansrouter :20128 bound" || bad "vansrouter not bound"

# ─────────────────────────────────────────────────────────────────────
echo
echo "── 6. Verify NVIDIA chat ──"

echo "  probing POST /v1/chat/completions with $NVIDIA_MODEL..."
resp="$(curl -s -X POST "http://127.0.0.1:20128/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(grep -E '^API_KEY_SECRET=' "$VANS_ENV" | cut -d= -f2-)" \
  -d "{\"model\":\"$NVIDIA_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}],\"max_tokens\":5}" \
  --max-time 30 2>/dev/null)"

if echo "$resp" | grep -q '"choices"'; then
  ok "NVIDIA chat works"
  echo "$resp" | jq -r '.choices[0].message.content // .' 2>/dev/null | head -3 | sed 's/^/    /'
else
  bad "NVIDIA chat still failing"
  echo "    $resp" | head -c 300
  echo
  echo "  recent vansrouter log:"
  pitchfork logs estate/vansrouter --raw -n 30 --no-pager 2>&1 | tail -15 | sed 's/^/    /'
fi

# ─────────────────────────────────────────────────────────────────────
echo
echo "── 7. Latest vansrouter log (diagnostic) ──"
pitchfork logs estate/vansrouter --raw -n 20 --no-pager 2>&1 | tail -15 | sed 's/^/  /'

echo
echo "DONE"
