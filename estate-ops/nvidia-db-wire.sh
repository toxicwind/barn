#!/usr/bin/env bash
set -euo pipefail

DB=/home/toxic/.9router/db/data.sqlite
ENV_SYSTEMD=/home/toxic/.9router/env.systemd

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }

NVIDIA_KEY="$(grep -E '^NVIDIA_API_KEY=' "$ENV_SYSTEMD" | head -1 | cut -d= -f2-)"
[ -n "$NVIDIA_KEY" ] || { bad "no NVIDIA_API_KEY in $ENV_SYSTEMD"; exit 1; }

echo "── 1. providerConnections schema ──"
sqlite3 "$DB" "PRAGMA table_info(providerConnections);" | sed 's/^/  /'

echo
echo "── 2. existing rows (structure, keys masked) ──"
sqlite3 -json "$DB" "SELECT * FROM providerConnections LIMIT 5;" 2>/dev/null | \
  jq -r '.[] | to_entries[] | "  \(.key): \(.value|tostring|.[0:60])"' | head -40

echo
echo "── 3. any nvidia row? ──"
nvidia_rows="$(sqlite3 "$DB" "SELECT COUNT(*) FROM providerConnections WHERE provider LIKE '%nvidia%' OR name LIKE '%nvidia%' OR slug LIKE '%nvidia%';" 2>/dev/null || echo 0)"
echo "  matches: $nvidia_rows"

echo
echo "── 4. providerNodes schema + nvidia ──"
sqlite3 "$DB" "PRAGMA table_info(providerNodes);" | sed 's/^/  /'
echo
sqlite3 -json "$DB" "SELECT * FROM providerNodes WHERE provider LIKE '%nvidia%' OR name LIKE '%nvidia%' OR id LIKE '%nvidia%';" 2>/dev/null | jq . | head -60

echo
echo "── 5. sample of providerNodes (any provider) ──"
sqlite3 -json "$DB" "SELECT * FROM providerNodes LIMIT 3;" 2>/dev/null | jq '.[0]' | head -40

echo
echo "── 6. apiKeys schema ──"
sqlite3 "$DB" "PRAGMA table_info(apiKeys);" | sed 's/^/  /'
sqlite3 -json "$DB" "SELECT * FROM apiKeys;" 2>/dev/null | jq -r '.[] | "  id=\(.id) name=\(.name) key=\(.key // .apiKey // .token | .[0:12])... active=\(.active // .enabled)"' | head -10

echo
echo "── 7. combos / settings (routing hints) ──"
sqlite3 "$DB" "SELECT * FROM settings WHERE key LIKE '%nvidia%' OR key LIKE '%provider%';" 2>/dev/null | head -20

echo
echo "DONE — paste this output"
