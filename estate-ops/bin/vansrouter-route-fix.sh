#!/usr/bin/env bash
set -euo pipefail

VR=http://127.0.0.1:20128
EXT=/home/toxic/.tau/extensions/vansrouter.ts
CHUTE=/home/toxic/pens/barn/chute
OMP=/home/toxic/tau/packages/coding-agent/dist/tau
PITCH=/home/toxic/estate/pitchfork.toml
PORT=25111

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1"; }
hdr()  { echo -e "\n${C}=== $1 ===${N}"; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. What is actually on :20128"

ss -tlnp '( sport = :20128 )' 2>/dev/null || echo "  (nothing)"

echo
echo "  process tree:"
VR_PID="$(ss -tlnpH '( sport = :20128 )' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$VR_PID" ]; then
  ps -o pid,ppid,cmd -p "$VR_PID" 2>/dev/null
  # walk up to find the sh script
  PPID_1="$(ps -o ppid= -p "$VR_PID" 2>/dev/null | tr -d ' ')"
  [ -n "$PPID_1" ] && ps -o pid,ppid,cmd -p "$PPID_1" 2>/dev/null || true
else
  warn "no pid on :20128"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "2. Probe candidate routes"

probe() {
  local method="$1" path="$2" body="${3:-}"
  local code
  if [ -n "$body" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" \
      -H 'Content-Type: application/json' \
      -d "$body" "${VR}${path}" --max-time 4 || echo "ERR")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" \
      "${VR}${path}" --max-time 4 || echo "ERR")
  fi
  printf '  %-6s %-45s %s\n' "$method" "$path" "$code"
}

echo "  GET routes:"
probe GET /v1/models
probe GET /api/v1/models
probe GET /models
probe GET /api/models
probe GET /api/health
probe GET /health
probe GET /

echo
echo "  POST chat routes:"
CHAT_BODY='{"model":"oc/jev-1.13-free","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
probe POST /v1/chat/completions "$CHAT_BODY"
probe POST /api/v1/chat/completions "$CHAT_BODY"
probe POST /chat/completions "$CHAT_BODY"
probe POST /api/chat "$CHAT_BODY"
probe POST /api/chat/completions "$CHAT_BODY"

echo
echo "  POST completions routes:"
COMP_BODY='{"model":"oc/jev-1.13-free","prompt":"hi","max_tokens":1}'
probe POST /v1/completions "$COMP_BODY"
probe POST /api/v1/completions "$COMP_BODY"

# ─────────────────────────────────────────────────────────────────────
hdr "3. Read vansrouter source routes"

VR_DIR=""
for candidate in \
  /home/toxic/pens/ranch/vansrouter \
  /home/toxic/estate/stack/services \
  /home/toxic/pens/ranch/vansrouter \
  /home/toxic/vansrouter
do
  if [ -d "$candidate" ]; then
    VR_DIR="$candidate"
    break
  fi
done

if [ -z "$VR_DIR" ]; then
  echo "  vansrouter.sh contents:"
  sed -n '1,60p' /home/toxic/estate/stack/services/vansrouter.sh 2>/dev/null || echo "  (missing)"
else
  ok "vansrouter dir: $VR_DIR"
  echo
  echo "  route files (Next.js app/ or pages/api/):"
  find "$VR_DIR" -type f \( -name 'route.ts' -o -name 'route.js' -o -name '*.ts' -o -name '*.js' \) \
    -path '*v1*' -not -path '*/node_modules/*' -not -path '*/.next/*' 2>/dev/null | head -30
fi

# also check the sh for exec target
echo
echo "  vansrouter.sh exec line:"
grep -nE '^(exec|node|bun|next)' /home/toxic/estate/stack/services/vansrouter.sh 2>/dev/null | head -10 || true

# ─────────────────────────────────────────────────────────────────────
hdr "4. Ask vansrouter what routes it knows (Next.js _next introspection)"

# Next.js exposes its build manifest sometimes
for f in /_next/static/chunks/app-pages-internals.js /_next/static/chunks/webpack.js /_next/static/chunks/main-app.js; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${VR}${f}" --max-time 3 || echo ERR)
  echo "  GET ${f} -> ${code}"
done

# ─────────────────────────────────────────────────────────────────────
hdr "5. OMP error capture — what URL did it call?"

echo "  recent pitchfork tau logs:"
journalctl --user -n 200 --no-pager 2>/dev/null | grep -iE 'vansrouter|chat/completions|404' | tail -20 || \
  tail -200 /home/toxic/.local/state/pitchfork/logs/pitchfork/pitchfork.log 2>/dev/null | grep -iE 'vansrouter|chat/completions|404' | tail -20 || \
  echo "  (no logs found)"

echo
echo "  chute stdout/stderr (last 40 lines):"
if [ -f /home/toxic/.local/state/pitchfork/logs/pitchfork/pitchfork.log ]; then
  grep -E '\[chute|\[bridge' /home/toxic/.local/state/pitchfork/logs/pitchfork/pitchfork.log 2>/dev/null | tail -40 || echo "  (no chute lines)"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "6. Direct chat POST against vansrouter (verbose)"

echo "  --- POST /v1/chat/completions ---"
curl -sv -X POST "${VR}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-estate' \
  -d '{"model":"oc/jev-1.13-free","messages":[{"role":"user","content":"say hi"}],"max_tokens":8}' \
  --max-time 15 2>&1 | tail -40

echo
echo "  --- POST /api/v1/chat/completions ---"
curl -sv -X POST "${VR}/api/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-estate' \
  -d '{"model":"oc/jev-1.13-free","messages":[{"role":"user","content":"say hi"}],"max_tokens":8}' \
  --max-time 15 2>&1 | tail -40

# ─────────────────────────────────────────────────────────────────────
hdr "7. Git log for vansrouter route changes"

if [ -d "$VR_DIR/.git" ]; then
  cd "$VR_DIR"
  git log --oneline -20 -- 2>/dev/null | head -20 || true
fi

echo
echo -e "${G}=== DIAGNOSTIC COMPLETE ===${N}"
echo "paste the full output"
