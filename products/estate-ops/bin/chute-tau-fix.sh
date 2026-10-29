#!/usr/bin/env bash
set -euo pipefail

CHUTE=/home/toxic/pens/barn/chute
PITCH=/home/toxic/estate/pitchfork.toml
OMP_NEW=/home/toxic/tau
PORT=25111
EXT=/home/toxic/.tau/extensions/vansrouter.ts
BIN=/home/toxic/estate/bin

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1"; }
hdr()  { echo -e "\n${C}=== $1 ===${N}"; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. Cleanup wrong artifacts"

rm -rf "$CHUTE/acp"
ok "removed chute/acp/ (my earlier mistake)"
rm -f "$CHUTE/chute.mjs.bak"
ok "removed chute.mjs.bak (stale CJS variant)"

# ─────────────────────────────────────────────────────────────────────
hdr "2. Fix bin symlinks (repo consolidation leftovers)"

if [ -x "$OMP_NEW/packages/coding-agent/dist/tau" ]; then
  ln -sfn "$OMP_NEW/packages/coding-agent/dist/tau" "$BIN/omp"
  ok "bin/omp -> $OMP_NEW/packages/coding-agent/dist/tau"
else
  warn "omp binary not at $OMP_NEW/packages/coding-agent/dist/tau"
fi

if [ -f "$OMP_NEW/launcher/tau" ]; then
  ln -sfn "$OMP_NEW/launcher/tau" "$BIN/tau"
  ok "bin/tau -> $OMP_NEW/launcher/tau"
else
  warn "tau launcher not at $OMP_NEW/launcher/tau"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "3. Rewrite chute.mjs as thin dispatcher over src/"

cat > "$CHUTE/chute.mjs" <<'ENTRY'
#!/usr/bin/env node
// chute — TCP <-> stdio ACP passage for the herd.
// Entry point. Thin dispatcher over src/.
//
// Usage:
//   chute [--port N] [--check] -- <cmd> [args...]
//
// See README.md for protocol behavior and design notes.

import { parseArgs } from "./src/args.mjs";
import { runCheck } from "./src/check.mjs";
import { createChuteServer } from "./src/server.mjs";
import { log } from "./src/log.mjs";

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.valid) {
    if (parsed.error) log("", parsed.error);
    else log("", "usage: chute [--port N] [--check] -- <cmd> [args...]");
    process.exit(2);
  }

  if (parsed.check) {
    const r = await runCheck();
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exit(r.ready ? 0 : 1);
  }

  createChuteServer({ port: parsed.port, cmd: parsed.cmd }).listen();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log("", sig + " received, exiting");
      process.exit(0);
    });
  }
}

main().catch((e) => {
  log("", "fatal: " + e.message);
  process.exit(1);
});
ENTRY

chmod +x "$CHUTE/chute.mjs"
ok "wrote $CHUTE/chute.mjs ($(wc -l < "$CHUTE/chute.mjs") lines, uses src/)"

# ─────────────────────────────────────────────────────────────────────
hdr "4. chute test suite (verify library works)"

cd "$CHUTE"
if bun test 2>&1 | tail -15; then
  ok "chute tests PASS"
else
  err "chute tests FAIL"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────
hdr "5. Insert [daemons.tau] into pitchfork.toml (idempotent)"

export PITCH_P="$PITCH"
export CHUTE_P="$CHUTE/chute.mjs"
export OMP_P="$OMP_NEW/packages/coding-agent/dist/tau"
export EXT_P="$EXT"
export PORT_N="$PORT"

bun -e "$(cat <<'JSEOF'
import fs from "fs";
const PITCH = process.env.PITCH_P;
const CHUTE = process.env.CHUTE_P;
const OMP   = process.env.OMP_P;
const EXT   = process.env.EXT_P;
const PORT  = parseInt(process.env.PORT_N, 10);

const block = [
  "# tau — omp acp exposed as TCP daemon via chute (mcpServers normalization).",
  "# chute is the canonical bridge: pens/barn/chute/chute.mjs",
  "[daemons.tau]",
  `port = ${PORT}`,
  `run = "exec ${CHUTE} --port ${PORT} -- ${OMP} acp -e ${EXT}"`,
  `dir = "/home/toxic"`,
  "mise = false",
  "retry = true",
  `ready_cmd = "${process.env.HOME || "/home/toxic"}/estate/bin/tcp-probe ${PORT}"`,
  `depends = ["wrangler"]`,
  // This script REWRITES the [daemons.tau] block, so a stale env line here
  // re-injects the dead vars into pitchfork.toml. PI_AGENT_DIR,
  // PI_REASONING_LEVEL and PI_SUBAGENT_MODEL have 0 readers in the tau
  // monorepo; PI_CODING_AGENT_DIR is the one settings.ts:601 consults.
  `env = { PI_CONFIG_DIR = "/home/toxic/.tau", PI_CODING_AGENT_DIR = "/home/toxic/.tau/agent", PI_CODING_AGENT = "true", PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "120000", VANSROUTER_API_KEY = "local-estate" }`,
  `auto = ["start"]`,
  "",
];

let raw = fs.readFileSync(PITCH, "utf-8");
let lines = raw.split("\n");

// Strip existing [daemons.tau] block plus any adjacent tau-header comments
const idx = lines.findIndex(l => l.trim() === "[daemons.tau]");
if (idx !== -1) {
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\[(daemons|groups)\./.test(lines[i].trim())) { end = i; break; }
  }
  let start = idx;
  while (start > 0 && lines[start - 1].trim().startsWith("#") && /tau/i.test(lines[start - 1])) {
    start--;
  }
  lines.splice(start, end - start);
}

// Insert after [daemons.wrangler] block
let insertAt = lines.length;
const wranglerIdx = lines.findIndex(l => l.trim() === "[daemons.wrangler]");
if (wranglerIdx !== -1) {
  for (let i = wranglerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("[")) { insertAt = i; break; }
  }
}

lines.splice(insertAt, 0, ...block);
fs.copyFileSync(PITCH, PITCH + ".bak." + Date.now());
fs.writeFileSync(PITCH, lines.join("\n"));
console.log(`  inserted at line ${insertAt + 1}`);
JSEOF
)"

# ─────────────────────────────────────────────────────────────────────
hdr "6. Kill stale port holder + restart tau"

cd /home/toxic/estate

STALE_PID="$(ss -tlnpH '( sport = :'"$PORT"' )' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$STALE_PID" ]; then
  warn "killing stale holder pid $STALE_PID on :$PORT"
  kill -TERM "$STALE_PID" 2>/dev/null || true
  sleep 1
  kill -KILL "$STALE_PID" 2>/dev/null || true
  ok "killed $STALE_PID"
else
  ok "no stale holder on :$PORT"
fi

pitchfork clean --daemon estate/tau 2>&1 || true

if [ -x "$BIN/pitchfork-restart" ]; then
  "$BIN/pitchfork-restart" estate/tau 2>&1 | tail -8 || true
else
  pitchfork restart estate/tau 2>&1 | tail -8 || true
fi

sleep 3

# ─────────────────────────────────────────────────────────────────────
hdr "7. Verify"

echo "--- port ---"
ss -tlnp '( sport = :'"$PORT"' )' 2>/dev/null || echo "  NOT LISTENING"

echo
echo "--- pitchfork status ---"
pitchfork list --json 2>&1 | jq -r '.[] | select(.id == "estate/tau") | "  \(.id) \(.status) port=\(.port|join(",")) pid=\(.pid)"' 2>&1 || true

echo
echo "--- ACP handshake ---"
export PORT_N="$PORT"
bun -e "$(cat <<'JSEOF'
import net from "net";
const PORT = parseInt(process.env.PORT_N, 10);
const s = net.connect(PORT, "127.0.0.1");
let buf = "";
let done = false;
const finish = () => { if (!done) { done = true; try { s.end(); } catch {} } };

s.on("connect", () => {
  s.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientInfo: { name: "verify", version: "1.0" }, clientCapabilities: {} }
  }) + "\n");
});

s.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 1) {
        console.log("  initialize: " + (m.result?.agentInfo?.name || JSON.stringify(m.error)));
        s.write(JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "session/new",
          params: { cwd: "/home/toxic", mcpServers: [] }
        }) + "\n");
      } else if (m.id === 2) {
        if (m.result?.sessionId) console.log("  session/new: " + m.result.sessionId);
        else console.log("  session/new: " + JSON.stringify(m.error));
        finish();
      }
    } catch {}
  }
});

s.on("error", e => { console.log("  error: " + e.message); finish(); });
s.on("close", () => { if (!done) console.log("  closed before response"); });
setTimeout(() => { if (!done) console.log("  timeout"); process.exit(0); }, 8000);
JSEOF
)"

# ─────────────────────────────────────────────────────────────────────
hdr "DONE"
echo "  chute  : $CHUTE/chute.mjs"
echo "  probe  : bun $CHUTE/test/smoke.test.mjs"
echo "  rerun  : bash $BIN/chute-tau-fix.sh"
echo

