#!/usr/bin/env bash
set -uo pipefail

VR=http://127.0.0.1:20128
VR_DIR=/home/toxic/pens/ranch/vansrouter
EXT=/home/toxic/.tau/extensions/vansrouter.ts
OMODELS=/home/toxic/.tau/models.json
TAU_CONFIG=/home/toxic/.tau/config.json
HERD=http://127.0.0.1:25100
TAU_PORT=25111

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1"; }
hdr()  { echo -e "\n${C}=== $1 ===${N}"; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. Confirm what vansrouter actually returns"

echo "  --- valid model (oc/jev-1.13-free) ---"
curl -s -o /tmp/vr-valid.txt -w "  HTTP %{http_code} (%{size_download}b)\n" \
  -X POST "$VR/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-estate' \
  -d '{"model":"oc/jev-1.13-free","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
  --max-time 15
echo "  body head:"; head -c 400 /tmp/vr-valid.txt | tr -d '\0'; echo

echo
echo "  --- doubled model (nvidia/nvidia/nemotron-3-super-120b-a12b) ---"
curl -s -o /tmp/vr-double.txt -w "  HTTP %{http_code} (%{size_download}b)\n" \
  -X POST "$VR/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-estate' \
  -d '{"model":"nvidia/nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
  --max-time 15
echo "  body head:"; head -c 400 /tmp/vr-double.txt | tr -d '\0'; echo

echo
echo "  --- stripped model (nvidia/nemotron-3-super-120b-a12b) ---"
curl -s -o /tmp/vr-strip.txt -w "  HTTP %{http_code} (%{size_download}b)\n" \
  -X POST "$VR/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-estate' \
  -d '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
  --max-time 15
echo "  body head:"; head -c 400 /tmp/vr-strip.txt | tr -d '\0'; echo

# ─────────────────────────────────────────────────────────────────────
hdr "2. vansrouter upstream config"

for f in "$VR_DIR/.env" "$VR_DIR/.env.local" "$VR_DIR/config.json" "$VR_DIR/.vansrouter.json" \
         "/home/toxic/.config/vansrouter/env" "/home/toxic/.config/vansrouter/config.json"; do
  [ -f "$f" ] && echo "  --- $f ---" && grep -vE '^\s*#|^\s*$' "$f" 2>/dev/null | head -30
done

echo
echo "  env from running process:"
VR_PID="$(ss -tlnpH '( sport = :20128 )' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$VR_PID" ]; then
  tr '\0' '\n' < /proc/$VR_PID/environ 2>/dev/null | grep -iE 'API_KEY|PROVIDER|UPSTREAM|BASE_URL' | head -20
fi

# ─────────────────────────────────────────────────────────────────────
hdr "3. What OMP thinks its models are"

if [ -f "$OMODELS" ]; then
  echo "  $OMODELS:"
  jq -r '.. | objects | select(has("id")) | .id' "$OMODELS" 2>/dev/null | sort -u | head -40 || cat "$OMODELS" | head -60
else
  warn "$OMODELS missing"
fi

echo
echo "  OMP session state:"
find /home/toxic/.tau -maxdepth 3 -name 'session*' -o -name '*.state.json' 2>/dev/null | head -5 | while read -r f; do
  echo "  --- $f ---"
  grep -oE '"model"[^,}]*' "$f" 2>/dev/null | head -3
done

echo
echo "  .tau dir tree:"
ls -la /home/toxic/.tau/ 2>/dev/null | head -20

# ─────────────────────────────────────────────────────────────────────
hdr "4. Herd as fallback (114 models, works)"

echo "  herd models (first 5):"
curl -s "$HERD/v1/models" --max-time 3 | jq -r '.data[0:5][].id' 2>/dev/null || echo "  herd not reachable"

# ─────────────────────────────────────────────────────────────────────
hdr "5. Fix: patch vansrouter.ts to filter bad IDs + register clean defaults"

cp "$EXT" "$EXT.bak.$(date +%s)"

cat > "$EXT" <<'TS'
import fs from "fs";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

const KNOWN_PROVIDERS = new Set([
  "oc", "mmf", "nvidia", "openai", "anthropic", "google", "groq",
  "openrouter", "cerebras", "hf", "nim", "vansrouter",
]);

function resolveApiKey(): string {
  if (process.env.VANSROUTER_API_KEY?.trim()) return process.env.VANSROUTER_API_KEY.trim();
  if (process.env.API_KEY_SECRET?.trim()) return process.env.API_KEY_SECRET.trim();
  for (const f of ["/home/toxic/.config/vansrouter/env", "/home/toxic/.secrets"]) {
    try {
      const raw = fs.readFileSync(f, "utf-8");
      const m = raw.match(/^(?:VANSROUTER_API_KEY|API_KEY_SECRET)=(.*)$/m);
      if (m?.[1]) {
        const k = m[1].trim().replace(/^["']|["']$/g, "").trim();
        if (k) return k;
      }
    } catch {}
  }
  return "local-estate";
}

// Collapse accidental double prefixes like nvidia/nvidia/foo -> nvidia/foo
// and strip a single leading prefix that duplicates the segment after it.
function cleanModelId(raw: string): string {
  if (!raw) return raw;
  const parts = raw.split("/");
  // Collapse consecutive duplicates: a/a/b/c -> a/b/c
  const collapsed: string[] = [];
  for (const p of parts) {
    if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== p) collapsed.push(p);
  }
  return collapsed.join("/");
}

function inferCapabilities(id: string) {
  const lower = id.toLowerCase();
  const vision = /vision|llava|qwen.*vl|gpt-4|gpt-5|claude|gemini|image/.test(lower);
  const reasoning = /reason|think|o1|o3|r1|nemotron|deepseek-r/.test(lower);
  return { vision, reasoning };
}

function toProviderModel(m: { id?: string; name?: string }): ProviderModelConfig {
  const rawId = String(m.id ?? "");
  const id = cleanModelId(rawId);
  const { vision, reasoning } = inferCapabilities(id);
  return {
    id,
    name: String(m.name ?? id),
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning,
  };
}

// Curated seed — only IDs vansrouter actually serves.
const SEED_MODELS: ProviderModelConfig[] = [
  "oc/jev-1.13-free",
  "oc/mimo-v2.5-free",
  "oc/deepseek-v4-flash-free",
  "oc/nemotron-3.5-lightning-free",
  "mmf/mimo-auto",
].map((id) => toProviderModel({ id }));

export default function vansrouterExtension(pi: ExtensionAPI): void {
  const baseUrl = process.env.VANSROUTER_URL || "http://127.0.0.1:20128/v1";
  const apiKey = resolveApiKey();

  const register = (models: ProviderModelConfig[]) => {
    pi.registerProvider("vansrouter", {
      baseUrl,
      apiKey,
      api: "openai-completions",
      authHeader: true,
      models,
    } as ProviderConfig);
  };

  // Sync registration — session/new never throws
  register(SEED_MODELS);

  // Async discovery — replace with whatever the live catalog actually has,
  // but always sanitize IDs and drop anything that still looks doubled.
  pi.on("session_start", async (_e, ctx) => {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
      const raw = Array.isArray(json?.data) ? json.data : [];

      const seen = new Set<string>();
      const live: ProviderModelConfig[] = [];
      for (const m of raw) {
        const pm = toProviderModel(m);
        const segments = pm.id.split("/");
        // Require exactly one provider segment + one model name
        if (segments.length < 2) continue;
        if (segments[0] === segments[1]) continue; // doubled
        if (seen.has(pm.id)) continue;
        seen.add(pm.id);
        live.push(pm);
      }

      if (live.length > 0) {
        register(live);
        ctx?.ui?.notify?.(`[vansrouter] synced ${live.length} live models`);
        return;
      }
    } catch (e) {
      // fall through
    }
    ctx?.ui?.notify?.(`[vansrouter] using ${SEED_MODELS.length} seed models`);
  });
}
TS

ok "patched $EXT"

# ─────────────────────────────────────────────────────────────────────
hdr "6. Force OMP to prefer vansrouter for this session"

# Ensure OMP has a valid default model registered
if [ -f "$TAU_CONFIG" ]; then
  cp "$TAU_CONFIG" "$TAU_CONFIG.bak.$(date +%s)"
  ok "backed up $TAU_CONFIG"
fi

# Write a fresh models.json with sane defaults if missing
if [ ! -f "$OMODELS" ]; then
  mkdir -p "$(dirname "$OMODELS")"
  cat > "$OMODELS" <<'JSON'
{
  "providers": {
    "vansrouter": {
      "baseUrl": "http://127.0.0.1:20128/v1",
      "api": "openai-completions",
      "authHeader": true,
      "defaultModel": "oc/jev-1.13-free"
    },
    "herd": {
      "baseUrl": "http://127.0.0.1:25100/v1",
      "api": "openai-completions",
      "defaultModel": "local-default"
    }
  },
  "default": {
    "provider": "vansrouter",
    "model": "oc/jev-1.13-free"
  }
}
JSON
  ok "wrote $OMODELS with vansrouter default"
else
  ok "$OMODELS already exists (left alone)"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "7. Restart tau"

cd /home/toxic/estate

STALE="$(ss -tlnpH '( sport = :'"$TAU_PORT"' )' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
[ -n "$STALE" ] && kill -TERM "$STALE" 2>/dev/null || true
sleep 1
[ -n "$STALE" ] && kill -KILL "$STALE" 2>/dev/null || true

pitchfork clean --daemon estate/tau 2>&1 | tail -2 || true
if [ -x /home/toxic/pens/barn/estate-ops/pitchfork-restart ]; then
  /home/toxic/pens/barn/estate-ops/pitchfork-restart estate/tau 2>&1 | tail -8 || true
else
  pitchfork restart estate/tau 2>&1 | tail -8 || true
fi
sleep 3

# ─────────────────────────────────────────────────────────────────────
hdr "8. End-to-end verify (real prompt through the whole stack)"

ss -tlnp '( sport = :'"$TAU_PORT"' )' 2>/dev/null || echo "  no listener"

echo
TAU_PORT=$TAU_PORT bun -e "$(cat <<'JSEOF'
import net from "net";
const PORT = parseInt(process.env.TAU_PORT, 10);
const s = net.connect(PORT, "127.0.0.1");
let buf = "", done = false;
const finish = () => { if (!done) { done = true; try { s.end(); } catch {} } };
s.on("connect", () => s.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: 1, clientInfo: { name: "e2e", version: "1" }, clientCapabilities: {} }
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
        console.log("  initialize: " + (m.result?.agentInfo?.name || JSON.stringify(m.error)));
        s.write(JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "session/new",
          params: { cwd: "/home/toxic", mcpServers: [] }
        }) + "\n");
      } else if (m.id === 2) {
        if (m.result?.sessionId) {
          console.log("  session/new: " + m.result.sessionId);
          s.write(JSON.stringify({
            jsonrpc: "2.0", id: 3, method: "session/prompt",
            params: { sessionId: m.result.sessionId, prompt: [{ type: "text", text: "reply with one word: ok" }] }
          }) + "\n");
        } else {
          console.log("  session/new FAILED: " + JSON.stringify(m.error));
          finish();
        }
      } else if (m.id === 3) {
        if (m.error) console.log("  prompt FAILED: " + JSON.stringify(m.error));
        else console.log("  prompt: stopReason=" + (m.result?.stopReason || "endTurn"));
        finish();
      }
    } catch {}
  }
});
s.on("error", e => { console.log("  socket error: " + e.message); finish(); });
setTimeout(() => { if (!done) console.log("  timeout"); process.exit(0); }, 60000);
JSEOF
)"

hdr "DONE"
echo "  extension : $EXT"
echo "  backup    : $EXT.bak.*"
echo "  rerun     : bash /home/toxic/pens/barn/estate-ops/vansrouter-final-fix.sh"
