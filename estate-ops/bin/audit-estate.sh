#!/usr/bin/env bash
# audit-estate.sh — what do we have and does it work right now
# Read-only. Touches nothing. Pure observation.

set +e
SOV=/home/toxic/estate
STOCK="$SOV/projects/range/ranch/tau"
OLD="$SOV/projects/tau"
CHUTE="$SOV/pens/barn/chute"
LAUNCHER="$STOCK/launcher/tau"
BIN="$SOV/bin"
PITCH="$SOV/pitchfork.toml"
TAU_HOME=/home/toxic

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; D='\033[2m'; N='\033[0m'
B='\033[1m'
ok()   { echo -e "  ${G}✓${N} $1"; }
bad()  { echo -e "  ${R}✗${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
hdr()  { echo -e "\n${C}${B}── $1 ──${N}"; }
sub()  { echo -e "${D}$1${N}"; }

START=$(date +%s)

# ═══════════════════════════════════════════════════════════════════════
echo -e "${C}${B}ESTATE AUDIT${N}  $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "${D}$(hostname) · user=$(whoami)${N}"

# ═══════════════════════════════════════════════════════════════════════
hdr "1. RUNNING DAEMONS (pitchfork registry)"

if command -v pitchfork >/dev/null 2>&1; then
  cd "$SOV" 2>/dev/null
  pj="$(pitchfork list --json 2>/dev/null)"
  if [ -n "$pj" ]; then
    echo "$pj" | jq -r '.[] | select(.status=="running") | "  \(.id) :\(.port // "-")"' 2>/dev/null | sort | head -40
    total="$(echo "$pj" | jq 'length' 2>/dev/null)"
    running="$(echo "$pj" | jq '[.[] | select(.status=="running")] | length' 2>/dev/null)"
    echo
    echo "  total=$total running=$running"
  else
    bad "pitchfork list returned nothing"
  fi
else
  bad "pitchfork not on PATH"
fi

# ═══════════════════════════════════════════════════════════════════════
hdr "2. KEY PORTS — listening?"

check_port() {
  local port="$1" name="$2"
  local line pid cmd
  line="$(ss -tlnH "( sport = :$port )" 2>/dev/null | head -1)"
  if [ -n "$line" ]; then
    pid="$(echo "$line" | grep -oP 'pid=\K[0-9]+' | head -1)"
    cmd=""
    [ -n "$pid" ] && cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 100)"
    ok "$(printf '%-10s' "$name") :$port  pid=$pid  ${D}$cmd${N}"
  else
    bad "$(printf '%-10s' "$name") :$port  NOT LISTENING"
  fi
}

check_port 25111 chute
check_port 25100 herd
check_port 25193 flock
check_port 25237 vansrouter
check_port 25127 wrangler
check_port 25130 browserless
check_port 25104 sov-router

# ═══════════════════════════════════════════════════════════════════════
hdr "3. HTTP HEALTH PROBES"

probe_http() {
  local name="$1" url="$2" expect="${3:-200}"
  local code time_ms
  time_ms="$(date +%s%3N)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || echo "ERR")"
  time_ms=$(( $(date +%s%3N) - time_ms ))
  if [ "$code" = "$expect" ]; then
    ok "$(printf '%-14s' "$name") $code  ${time_ms}ms  $url"
  else
    bad "$(printf '%-14s' "$name") $code  ${time_ms}ms  $url  (expected $expect)"
  fi
}

probe_http "herd"        "http://127.0.0.1:25100/health"
probe_http "flock"       "http://127.0.0.1:25193/health"
probe_http "wrangler"        "http://127.0.0.1:25127/health"
probe_http "vansrouter"  "http://127.0.0.1:25237/api/health"
probe_http "sov-router"  "http://127.0.0.1:25104/health"

# ═══════════════════════════════════════════════════════════════════════
hdr "4. ACP PIPELINE (chute → omp)"

if ss -tlnH "( sport = :25111 )" 2>/dev/null | grep -q LISTEN; then
  TAU_PORT=25111 bun -e '
import net from "net";
const PORT = parseInt(process.env.TAU_PORT, 10);
const s = net.connect(PORT, "127.0.0.1");
let buf = "", done = false;
const finish = () => { if (!done) { done = true; try { s.end(); } catch {} } };
s.on("connect", () => s.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: 1, clientInfo: { name: "audit", version: "1" }, clientCapabilities: {} }
}) + "\n"));
s.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 1) {
        if (m.error) { console.log("  ✗ initialize: " + JSON.stringify(m.error)); finish(); continue; }
        console.log("  ✓ initialize: " + m.result?.agentInfo?.name + " " + m.result?.agentInfo?.version);
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/home/toxic", mcpServers: [] } }) + "\n");
      } else if (m.id === 2) {
        if (m.error) { console.log("  ✗ session/new: " + JSON.stringify(m.error)); finish(); continue; }
        console.log("  ✓ session/new: " + m.result.sessionId);
        finish();
      }
    } catch {}
  }
});
s.on("error", e => { console.log("  ✗ socket: " + e.message); finish(); });
s.on("close", () => process.exit(0));
setTimeout(() => { console.log("  ⚠ timeout after 8s"); process.exit(0); }, 8000);
' 2>&1 | sed "s/^/  /"
else
  bad "chute not listening on 25111 — ACP pipeline down"
fi

# ═══════════════════════════════════════════════════════════════════════
hdr "5. MODEL ENDPOINTS — how many models served"

count_models() {
  local name="$1" url="$2" auth="${3:-}"
  local args=(-s --max-time 4)
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  local n
  n="$(curl "${args[@]}" "$url" 2>/dev/null | jq -r '(.data // .) | length' 2>/dev/null)"
  if [ -n "$n" ] && [ "$n" != "null" ]; then
    ok "$(printf '%-14s' "$name") $n models"
  else
    bad "$(printf '%-14s' "$name") no response / bad JSON"
  fi
}

count_models "herd"       "http://127.0.0.1:25100/v1/models"
count_models "vansrouter" "http://127.0.0.1:25237/v1/models"
[ -f "$TAU_HOME/.tau/flock.key" ] && count_models "flock" "http://127.0.0.1:25193/v1/models" "$(cat "$TAU_HOME/.tau/flock.key")"
count_models "sov-router" "http://127.0.0.1:25104/v1/models"

# ═══════════════════════════════════════════════════════════════════════
hdr "6. CHUTE PROJECT STATE"

if [ -d "$CHUTE" ]; then
  ok "chute dir: $CHUTE"
  for f in chute.mjs package.json README.md; do
    [ -f "$CHUTE/$f" ] && ok "  $f ($(wc -l < "$CHUTE/$f") lines)" || bad "  $f MISSING"
  done
  [ -d "$CHUTE/src" ] && ok "  src/ ($(find "$CHUTE/src" -name '*.mjs' | wc -l) modules)" || bad "  src/ MISSING"
  [ -d "$CHUTE/test" ] && ok "  test/ ($(find "$CHUTE/test" -name '*.test.mjs' | wc -l) test files)" || bad "  test/ MISSING"
  [ -d "$CHUTE/acp" ] && warn "  acp/ exists (my earlier mistake — should be deleted)" || ok "  no stray acp/"
  [ -f "$CHUTE/chute.mjs.bak" ] && warn "  chute.mjs.bak exists (stale backup)" || ok "  no stale .bak"

  if node --check "$CHUTE/chute.mjs" 2>/dev/null; then
    ok "  chute.mjs syntax OK"
  else
    bad "  chute.mjs syntax BROKEN"
  fi

  # run chute's own test suite
  if [ -f "$CHUTE/package.json" ]; then
    sub "running chute tests..."
    (cd "$CHUTE" && bun test 2>&1 | tail -3 | sed 's/^/    /')
  fi
else
  bad "chute dir missing: $CHUTE"
fi

# ═══════════════════════════════════════════════════════════════════════
hdr "7. TAU BINARY / LAUNCHER"

sub "ranch/tau tree:"
if [ -d "$STOCK" ]; then
  ok "  $STOCK"
  [ -d "$STOCK/.git" ] && ok "  .git  HEAD=$(git -C "$STOCK" rev-parse --short HEAD 2>/dev/null)" || warn "  no .git"
  [ -d "$STOCK/launcher" ] && ok "  launcher/" || bad "  launcher/ MISSING"
  for b in dist/tau dist/tau; do
    [ -x "$STOCK/packages/coding-agent/$b" ] && ok "  packages/coding-agent/$b ($(du -h "$STOCK/packages/coding-agent/$b" 2>/dev/null | cut -f1))" || bad "  packages/coding-agent/$b MISSING"
  done
else
  bad "  $STOCK MISSING"
fi

sub "launcher file:"
if [ -f "$LAUNCHER" ]; then
  ok "  $LAUNCHER ($(wc -l < "$LAUNCHER") lines)"
  if grep -q "ranch/tau" "$LAUNCHER"; then
    ok "  resolves stockyard first"
  elif grep -q "projects/tau/engine" "$LAUNCHER"; then
    bad "  resolves projects/tau/engine (OLD TREE)"
  fi
else
  bad "  $LAUNCHER MISSING"
fi

sub "bin/ symlinks:"
for f in "$BIN/tau" "$BIN/omp"; do
  if [ -L "$f" ]; then
    tgt="$(readlink -f "$f" 2>/dev/null)"
    if [ -e "$tgt" ]; then
      ok "  $f -> $tgt"
    else
      bad "  $f -> BROKEN ($(readlink "$f"))"
    fi
  elif [ -e "$f" ]; then
    warn "  $f exists (not a symlink)"
  else
    bad "  $f MISSING"
  fi
done

sub "bin/tau functionality:"
if [ -x "$BIN/tau" ]; then
  v="$("$BIN/tau" --version 2>&1 | head -1)"
  case "$v" in
    *omp*|*tau*|*18.*) ok "  --version: $v" ;;
    *) bad "  --version returned: $v" ;;
  esac
  c="$("$BIN/tau" --check 2>&1 | grep -E 'ENGINE_DIR|DIST_TAU' | head -3)"
  [ -n "$c" ] && echo "$c" | sed 's/^/    /' || warn "  --check not implemented"
else
  bad "  bin/tau not executable"
fi

# ═══════════════════════════════════════════════════════════════════════
hdr "8. ORPHAN PROCESSES"

sub "processes from OLD tree ($OLD/):"
old_pids="$(pgrep -f "projects/tau/" 2>/dev/null | grep -v "$$" | grep -v "audit-estate")"
if [ -n "$old_pids" ]; then
  for pid in $old_pids; do
    cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 120)"
    warn "  pid $pid: $cmd"
  done
else
  ok "  none"
fi

sub "processes from stockyard tree:"
stock_pids="$(pgrep -f "ranch/tau/" 2>/dev/null | grep -v "$$")"
if [ -n "$stock_pids" ]; then
  for pid in $stock_pids; do
    cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 120)"
    ok "  pid $pid: $cmd"
  done
else
  warn "  none (chute spawns per-connection, so this may be normal)"
fi

# ═══════════════════════════════════════════════════════════════════════
hdr "9. PITCHFORK TAU BLOCK"

if [ -f "$PITCH" ]; then
  sub "current [daemons.tau]:"
  awk '/^\[daemons\.tau\]/{f=1} f{print "    "$0} /^\[/{if(f && !/^\[daemons\.tau\]/){exit}}' "$PITCH" | head -15
  if grep -q '\[daemons\.tau\]' "$PITCH"; then
    ok "  block present"
    grep -q 'pens/barn/chute' "$PITCH" && ok "  references chute" || bad "  does not reference chute"
    grep -q 'port = 25111' "$PITCH" && ok "  port 25111 declared" || bad "  no port declared"
    grep -q 'health_port' "$PITCH" && ok "  health_port set" || warn "  no health_port"
  else
    bad "  [daemons.tau] block MISSING"
  fi
else
  bad "  $PITCH MISSING"
fi

# ═══════════════════════════════════════════════════════════════════════
hdr "10. VANSROUTER EXTENSION"

EXT="$TAU_HOME/.tau/extensions/vansrouter.ts"
if [ -f "$EXT" ]; then
  ok "  $EXT ($(wc -l < "$EXT") lines)"
  grep -q 'cleanModelId\|sanitize\|collapse' "$EXT" && ok "  has ID sanitization" || warn "  no ID sanitization visible"
  grep -q 'SEED_MODELS' "$EXT" && ok "  has seed models" || warn "  no seed models"
  grep -q 'local-estate' "$EXT" && ok "  has apiKey fallback" || warn "  no apiKey fallback"
else
  bad "  $EXT MISSING"
fi

sub "OMP config:"
for f in "$TAU_HOME/.tau/config.yml" "$TAU_HOME/.tau/models.json"; do
  if [ -f "$f" ]; then
    ok "  $f exists"
  else
    warn "  $f absent"
  fi
done

# ═══════════════════════════════════════════════════════════════════════
hdr "11. VANSROUTER CHAT ENDPOINT"

sub "POST /v1/chat/completions (oc/jev-1.13-free):"
code="$(curl -s -o /tmp/vr-audit-chat.txt -w '%{http_code}' --max-time 8 \
  -X POST "http://127.0.0.1:25237/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-estate' \
  -d '{"model":"oc/jev-1.13-free","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' 2>/dev/null)"
case "$code" in
  200) ok "  HTTP 200" ;;
  500) bad "  HTTP 500 — vansrouter upstream failure" ;;
  404) bad "  HTTP 404 — route missing" ;;
  401) warn "  HTTP 401 — auth failure" ;;
  *)   bad "  HTTP $code" ;;
esac
if [ -s /tmp/vr-audit-chat.txt ]; then
  head -c 200 /tmp/vr-audit-chat.txt | tr -d '\0' | sed 's/^/    /'
  echo
fi

# ═══════════════════════════════════════════════════════════════════════
hdr "12. DISK FOOTPRINT"

sub "deprecated tau trees:"
for d in /home/toxic/deprecated-tau-* /home/toxic/staging-* /home/toxic/.tau.bak.*; do
  [ -e "$d" ] && du -sh "$d" 2>/dev/null | sed 's/^/    /'
done

sub "worktrees with tau:"
for d in /home/toxic/edge-work /home/toxic/oracle-hardening-wt; do
  [ -d "$d" ] && du -sh "$d" 2>/dev/null | sed 's/^/    /'
done

sub "scratch with tau:"
ls -d /home/toxic/scratch/*tau* 2>/dev/null | sed 's/^/    /'

# ═══════════════════════════════════════════════════════════════════════
hdr "13. SUMMARY TABLE"

printf "  %-14s %-8s %s\n" "COMPONENT" "STATE" "DETAIL"
printf "  %-14s %-8s %s\n" "──────────" "──────" "──────"

summ() {
  local name="$1" ok="$2" detail="$3"
  if [ "$ok" = "1" ]; then
    printf "  %-14s ${G}%s${N}  %s\n" "$name" "✓" "$detail"
  else
    printf "  %-14s ${R}%s${N}  %s\n" "$name" "✗" "$detail"
  fi
}

[ -n "$(ss -tlnH '( sport = :25111 )' 2>/dev/null)" ] && summ "chute" 1 ":25111 bound" || summ "chute" 0 "not listening"
[ -n "$(ss -tlnH '( sport = :25100 )' 2>/dev/null)" ] && summ "herd" 1 ":25100 bound" || summ "herd" 0 "not listening"
[ -n "$(ss -tlnH '( sport = :25193 )' 2>/dev/null)" ] && summ "flock" 1 ":25193 bound" || summ "flock" 0 "not listening"
[ -n "$(ss -tlnH '( sport = :25127 )' 2>/dev/null)" ] && summ "wrangler" 1 ":25127 bound" || summ "wrangler" 0 "not listening"
[ -n "$(ss -tlnH '( sport = :25237 )' 2>/dev/null)" ] && summ "vansrouter" 1 ":25237 bound" || summ "vansrouter" 0 "not listening"

[ -L "$BIN/tau" ] && [ -e "$(readlink -f "$BIN/tau" 2>/dev/null)" ] && summ "bin/tau" 1 "-> stockyard" || summ "bin/tau" 0 "broken or missing"
[ -L "$BIN/omp" ] && [ -e "$(readlink -f "$BIN/omp" 2>/dev/null)" ] && summ "bin/omp" 1 "ok" || summ "bin/omp" 0 "broken or missing"

[ -f "$LAUNCHER" ] && summ "launcher" 1 "$(wc -l < "$LAUNCHER") lines" || summ "launcher" 0 "missing"
[ -d "$CHUTE/src" ] && summ "chute/src" 1 "$(find "$CHUTE/src" -name '*.mjs' | wc -l) modules" || summ "chute/src" 0 "missing"
[ -d "$CHUTE/test" ] && summ "chute/test" 1 "$(find "$CHUTE/test" -name '*.test.mjs' | wc -l) tests" || summ "chute/test" 0 "missing"

if [ -f "$EXT" ]; then
  grep -q 'cleanModelId\|sanitize' "$EXT" && summ "vansrouter.ts" 1 "sanitized" || summ "vansrouter.ts" 0 "unsanitized"
else
  summ "vansrouter.ts" 0 "missing"
fi

old_pids="$(pgrep -f 'projects/tau/' 2>/dev/null | grep -v "$$" | grep -v "audit-estate")"
if [ -z "$old_pids" ]; then
  summ "orphans" 1 "none"
else
  summ "orphans" 0 "$(echo "$old_pids" | wc -l) procs from old tree"
fi

# ═══════════════════════════════════════════════════════════════════════
echo
echo -e "${D}audit took $(( $(date +%s) - START ))s${N}"
echo -e "${D}log: $SOV/bin/audit-estate.log${N}"
echo
