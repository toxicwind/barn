#!/usr/bin/env bash
set -euo pipefail

DB=/home/toxic/.9router/db/data.sqlite
ENV_SYSTEMD=/home/toxic/.9router/env.systemd
VANS_ENV=/home/toxic/.config/vansrouter/env

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }
hdr() { echo -e "\n${C}══ $1 ══${N}"; }

NVIDIA_KEY="$(grep -E '^NVIDIA_API_KEY=' "$ENV_SYSTEMD" | head -1 | cut -d= -f2-)"
[ -n "$NVIDIA_KEY" ] || { bad "no key"; exit 1; }
ok "key: ${NVIDIA_KEY:0:20}...${NVIDIA_KEY: -6}"

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

hdr "1. Purge any prior nvidia rows"
sqlite3 "$DB" "DELETE FROM providerConnections WHERE provider='nvidia';"
sqlite3 "$DB" "DELETE FROM providerNodes WHERE id='nvidia-pool';"
ok "purged"

hdr "2. Insert correct shape — authType='apikey', data={apiKey}"

DATA_JSON="{\"apiKey\":\"$NVIDIA_KEY\"}"
sqlite3 "$DB" <<SQL
INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
VALUES ('nvidia-personal', 'nvidia', 'apikey', 'Personal', NULL, 1, 1, '$DATA_JSON', '$NOW', '$NOW');
SQL

if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM providerConnections WHERE provider='nvidia';")" = "1" ]; then
  ok "row inserted"
  sqlite3 -json "$DB" "SELECT id, provider, authType, name, isActive, data FROM providerConnections WHERE provider='nvidia';" | jq . | sed 's/^/    /'
else
  bad "insert failed"
  exit 1
fi

hdr "3. Restart vansrouter"
cd /home/toxic/estate
pitchfork clean --daemon estate/vansrouter 2>&1 | tail -1 || true
pitchfork restart estate/vansrouter 2>&1 | tail -5 || true
sleep 4

ss -tlnH "( sport = :20128 )" | grep -q LISTEN && ok "bound" || { bad "not bound"; exit 1; }

hdr "4. Probe nvidia chat"
BEARER="$(grep -E '^API_KEY_SECRET=' "$VANS_ENV" | cut -d= -f2-)"

resp="$(curl -s -X POST "http://127.0.0.1:20128/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $BEARER" \
  -d '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"reply with exactly: ok"}],"max_tokens":5,"stream":false}' \
  --max-time 60 2>/dev/null)"

if echo "$resp" | grep -q '"choices"'; then
  ok "NVIDIA WORKS"
  echo "$resp" | jq -r '.choices[0].message.content' | sed 's/^/    /'
  echo
  ok "→ point OMP at nvidia/nemotron-3-super-120b-a12b"
else
  bad "still failing"
  echo "  resp: $resp" | head -c 400
  echo
  echo "  log:"
  pitchfork logs estate/vansrouter --raw -n 30 --no-pager 2>&1 | \
    grep -E 'nvidia|AUTH|PENDING|ERROR|GATEWAY' | tail -20 | sed 's/^/    /'
fi

hdr "DONE"
