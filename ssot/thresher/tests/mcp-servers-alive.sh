#!/usr/bin/env bash
# Contract (thresher SSOT): every enabled stdio MCP server must actually
# resolve to an executable AND complete an MCP initialize handshake.
#
# Fails loudly, listing EVERY broken server (not just the first).
# Servers are probed in parallel so the whole suite stays fast.
#
# Usage: mcp-servers-alive.sh [config.json]
set -uo pipefail

CONFIG="${1:-/home/toxic/pens/barn/ssot/thresher/mcp_config.json}"
PY="$(command -v python3)"
[ -n "$PY" ] || { echo "FAIL: python3 missing"; exit 1; }
[ -f "$CONFIG" ] || { echo "FAIL: config not found: $CONFIG"; exit 1; }

exec "$PY" - "$CONFIG" << 'PYEOF'
import json, os, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

cfg = json.load(open(sys.argv[1]))
servers = cfg.get("mcpServers") or cfg.get("servers") or []
if isinstance(servers, dict):
    servers = list(servers.values())

INIT = {
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "mcp-servers-alive", "version": "1.0.0"},
    },
}

TIMEOUT = float(os.environ.get("MCP_ALIVE_TIMEOUT", "10"))

# thresher inherits a PATH that includes these; a bare ssh shell does not.
EXTRA_PATH = [
    os.path.expanduser("~/.bun/bin"),
    os.path.expanduser("~/.local/bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
]
ENV = dict(os.environ)
ENV["PATH"] = os.pathsep.join(
    [p for p in EXTRA_PATH if os.path.isdir(p)] + [ENV.get("PATH", "")]
)


def probe(s):
    """Return None if healthy, else a failure string."""
    name = s.get("name", "?")
    cmd = s.get("command", "")
    args = s.get("args") or []

    if not cmd:
        return name + ": no command configured"

    resolved = cmd if os.path.exists(cmd) else shutil.which(cmd, path=ENV["PATH"])
    if not resolved:
        return name + ": command not found: " + cmd
    real = os.path.realpath(resolved)
    if not os.path.exists(real):
        return name + ": dangling symlink " + resolved + " -> " + real
    if not os.access(real, os.X_OK):
        return name + ": not executable: " + real

    # --- config-declared env (with ${VAR} expansion from the parent env) ---
    env = dict(ENV)
    for k, v in (s.get("env") or {}).items():
        env[k] = os.path.expandvars(str(v))

    try:
        p = subprocess.Popen(
            [real] + args,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=env,
        )
    except OSError as e:
        return name + ": cannot spawn " + real + ": " + str(e)

    try:
        p.stdin.write(json.dumps(INIT) + "\n")
        p.stdin.flush()
        deadline = time.time() + TIMEOUT
        resp = None
        while time.time() < deadline:
            line = p.stdout.readline()
            if not line:
                if p.poll() is not None:
                    break
                continue
            stripped = line.strip()
            if not stripped.startswith("{"):
                continue  # banner / log noise before the JSON-RPC reply
            try:
                resp = json.loads(stripped)
            except Exception:
                continue
            break
        if resp is None:
            try:
                p.kill()
                _, errout = p.communicate(timeout=3)
            except Exception:
                errout = ""
            errlines = [x for x in (errout or "").strip().splitlines() if x.strip()]
            tail = errlines[-1] if errlines else "no output"
            return name + ": no MCP initialize response (" + tail + ")"
        if isinstance(resp, dict) and "error" in resp:
            return name + ": initialize returned error: " + json.dumps(resp["error"])
        return None
    except Exception as e:
        return name + ": handshake crashed: " + str(e)
    finally:
        try:
            p.kill()
        except Exception:
            pass


targets = [
    s for s in servers
    if s.get("protocol") == "stdio" and s.get("enabled", True)
]

with ThreadPoolExecutor(max_workers=16) as ex:
    results = list(ex.map(probe, targets))

failures = [r for r in results if r]

print("checked " + str(len(targets)) + " stdio MCP server(s)")
if failures:
    print("")
    for f in sorted(failures):
        print("FAIL " + f)
    print("")
    print(str(len(failures)) + " broken server(s)")
    sys.exit(1)

print("OK: all stdio MCP servers resolve and answer initialize")
PYEOF
