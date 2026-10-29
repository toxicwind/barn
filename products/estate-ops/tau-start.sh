#!/usr/bin/env bash
set -euo pipefail

PITCH=/home/toxic/estate/pitchfork.toml
CHUTE=/home/toxic/pens/barn/chute/chute.mjs
OMP=/home/toxic/tau/packages/coding-agent/dist/tau
EXT=/home/toxic/.tau/extensions/vansrouter.ts
PORT=25111
TAU_DIR=/home/toxic

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1"; }
hdr()  { echo -e "\n${C}=== $1 ===${N}"; }

# ─────────────────────────────────────────────────────────────────────
hdr "0. Preflight"

[ -f "$PITCH" ]        || { err "missing $PITCH"; exit 1; }
[ -x "$CHUTE" ]        || { err "missing $CHUTE"; exit 1; }
[ -x "$OMP" ]          || { err "missing $OMP"; exit 1; }
[ -f "$EXT" ]          || { err "missing $EXT"; exit 1; }
ok "all paths exist"

node --check "$CHUTE" 2>/dev/null && ok "chute syntax OK" || { err "chute syntax broken"; exit 1; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. Current [daemons.tau] in pitchfork.toml"

awk '/^\[daemons\.tau\]/{f=1} f{print NR": "$0} /^\[/{if(f && !/^\[daemons\.tau\]/){exit}}' "$PITCH" || echo "  (block missing)"

# ─────────────────────────────────────────────────────────────────────
hdr "2. Remove .tau/models.json monkey patch (not read by OMP)"

rm -f /home/toxic/.tau/models.json
rm -f /home/toxic/.tau/config.json
ok "removed non-canonical files"

# ─────────────────────────────────────────────────────────────────────
hdr "3. Rewrite [daemons.tau] block canonically"

cp "$PITCH" "$PITCH.bak.$(date +%s)"

python3 - "$PITCH" "$CHUTE" "$OMP" "$EXT" "$PORT" "$TAU_DIR" <<'PY'
import sys, re
p, chute, omp, ext, port, tau_dir = sys.argv[1:7]

lines = open(p).read().split("\n")

# Strip any existing [daemons.tau] block
out, skipping = [], False
for line in lines:
    s = line.strip()
    if s == "[daemons.tau]":
        skipping = True
        continue
    if skipping and re.match(r"^\[(daemons|groups)\.", s):
        skipping = False
    if not skipping:
        out.append(line)
lines = out

# Insert canonical block after [daemons.wrangler]
wrangler_idx = next(i for i, l in enumerate(lines) if l.strip() == "[daemons.wrangler]")
end = next((i for i in range(wrangler_idx + 1, len(lines)) if lines[i].strip().startswith("[")), len(lines))

block = [
    "",
    "[daemons.tau]",
    "# omp acp exposed as TCP daemon via chute (stdio→TCP + mcpServers normalization)",
    f"port = {port}",
    f'run = "exec {chute} --port {port} -- {omp} acp -e {ext}"',
    f'dir = "{tau_dir}"',
    "mise = false",
    "retry = true",
    f'ready_cmd = "/home/toxic/pens/barn/estate-ops/tcp-probe {port}"',
    'health_port = { port = ' + port + ', interval = "30s", timeout = "5s", retries = 3 }',
    'depends = ["wrangler"]',
    # Keep this in sync with pitchfork.toml [daemons.tau] env. PI_AGENT_DIR,
    # PI_REASONING_LEVEL and PI_SUBAGENT_MODEL were removed: the tau monorepo
    # has 0 source files reading any of them, so `thinkingmachines/inkling`
    # never took effect. PI_CODING_AGENT_DIR is the variable that actually
    # decides which config.yml settings.ts:601 reads.
    'env = { PI_CONFIG_DIR = "/home/toxic/.tau", PI_CODING_AGENT_DIR = "/home/toxic/.tau/agent", PI_CODING_AGENT = "true", PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "120000", VANSROUTER_API_KEY = "local-estate" }',
    'auto = ["start"]',
]

lines[end:end] = block
open(p, "w").write("\n".join(lines))
print(f"  inserted at line {end + 1}")
PY

ok "rewrote $PITCH"

echo
echo "  new block:"
awk '/^\[daemons\.tau\]/{f=1} f{print NR": "$0} /^\[/{if(f && !/^\[daemons\.tau\]/){exit}}' "$PITCH"

# ─────────────────────────────────────────────────────────────────────
hdr "4. Kill any stale holder on :$PORT"

STALE="$(ss -tlnpH "( sport = :$PORT )" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$STALE" ]; then
  warn "killing pid $STALE"
  kill -TERM "$STALE" 2>/dev/null || true
  sleep 1
  kill -KILL "$STALE" 2>/dev/null || true
fi
ok "port clear"

# ─────────────────────────────────────────────────────────────────────
hdr "5. Clean stale supervisor state + start"

cd /home/toxic/estate
pitchfork clean --daemon estate/tau 2>&1 | tail -2 || true
pitchfork start estate/tau 2>&1 | tail -10 || true

# ─────────────────────────────────────────────────────────────────────
hdr "6. Wait for :$PORT to bind"

for i in $(seq 1 20); do
  if ss -tlnH "( sport = :$PORT )" 2>/dev/null | grep -q LISTEN; then
    ok "bound after ${i}00ms"
    break
  fi
  sleep 0.5
done

ss -tlnp "( sport = :$PORT )" 2>/dev/null || { err "port never bound"; exit 1; }

echo
pitchfork list --json 2>&1 | jq -r '.[] | select(.id == "estate/tau") | "  status=\(.status) pid=\(.pid) port=\(.port|join(","))"' || true

# ─────────────────────────────────────────────────────────────────────
hdr "7. End-to-end: initialize → session/new → session/prompt"

TAU_PORT=$PORT bun -e "$(cat <<'JSEOF'
import net from "net";
const PORT = parseInt(process.env.TAU_PORT, 10);
const s = net.connect(PORT, "127.0.0.1");
let buf = "", done = false;
const finish = () => { if (!done) { done = true; try { s.end(); } catch {} } };

s.on("connect", () => s.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: 1, clientInfo: { name: "e2e", version: "1.0" }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } }
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
        if (m.error) { console.log("  initialize FAILED: " + JSON.stringify(m.error)); finish(); continue; }
        console.log("  initialize: " + m.result?.agentInfo?.name + " " + m.result?.agentInfo?.version);
        const method = m.result?.authMethods?.[0]?.id ?? "agent";
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: method } }) + "\n");
      } else if (m.id === 2) {
        console.log("  authenticate: " + (m.error ? "warn " + m.error.message : "ok"));
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "/home/toxic", mcpServers: [] } }) + "\n");
      } else if (m.id === 3) {
        if (m.error) { console.log("  session/new FAILED: " + JSON.stringify(m.error)); finish(); continue; }
        console.log("  session/new: " + m.result.sessionId);
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: m.result.sessionId, prompt: [{ type: "text", text: "reply with one word: ok" }] } }) + "\n");
      } else if (m.id === 4) {
        if (m.error) console.log("  prompt FAILED: " + JSON.stringify(m.error));
        else console.log("  prompt: stopReason=" + (m.result?.stopReason || "endTurn"));
        finish();
      }
    } catch {}
  }
});

s.on("error", e => { console.log("  socket error: " + e.message); finish(); });
s.on("close", () => { if (!done) console.log("  socket closed early"); process.exit(0); });
setTimeout(() => { if (!done) console.log("  timeout after 60s"); process.exit(0); }, 60000);
JSEOF
)"

hdr "READY"
echo "  tau listening on :$PORT"
echo "  re-run: bash /home/toxic/pens/barn/estate-ops/tau-start.sh"
