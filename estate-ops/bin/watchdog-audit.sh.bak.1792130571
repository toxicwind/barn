#!/usr/bin/env bash
# watchdog-audit.sh — claim-vs-reality audit for every watchdog/supervisor/health-check
# on hatch and yote. A watchdog that reports healthy while its target is dead,
# idle, or never ran is FAKE.
#
# Runs on EITHER box; auto-detects hatch vs yote by filesystem.
#   ./watchdog-audit.sh            # audit the local box
#   ./watchdog-audit.sh --verbose  # show every probe
# Exit 0 = all watchdogs real. Exit 1 = at least one FAKE/DOWN finding.
#
# Permanent home: sovereign-projects/projects/ops/bin/
# First run: 2026-09-20 (watchdog-hunter) — caught kimi-auto-canary-judge idle
# loop (removed), kimi-auto-shim pitchfork desync (fixed via pitchfork-restart),
# 11 auto-start pitchfork daemons down, 10 stale yote pidfiles (cleaned).
set -u
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

FAIL=0
say()  { printf '%s\n' "$*"; }
v()    { [ "$VERBOSE" = 1 ] && say "  probe: $*"; }
good() { say "REAL: $*"; }
bad()  { say "FAKE: $*"; FAIL=1; }
down() { say "DOWN: $*"; FAIL=1; }
warn() { say "WARN: $*"; }

BOX=unknown
[ -d /home/toxic/sovereign ] && BOX=yote
[ -d /home/hatch/workspace/cron.d ] && BOX=hatch
say "=== watchdog-audit on $BOX ($(date -u +%FT%TZ)) ==="

port_open() { # port_open <port> — real TCP connect, no parsing
  python3 -c "import socket,sys; s=socket.socket(); s.settimeout(4); s.connect(('127.0.0.1', $1))" 2>/dev/null
}
http_health() { # http_health <port> -> HTTP code or ERR
  curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$1/health" 2>/dev/null || echo "ERR"
}
file_fresh() { # file_fresh <path> <max_age_seconds>
  [ -f "$1" ] || return 1
  [ $(( $(date +%s) - $(stat -c %Y "$1" 2>/dev/null || echo 0) )) -lt "$2" ]
}

########################### HATCH ###########################
if [ "$BOX" = hatch ]; then
  CROND="$HOME/workspace/cron.d/minutely"
  # --- progress-watchdog (Hearth): enabled def + fresh state + recent alerts ---
  PWDEF=$(ls "$CROND"/progress-watchdog__interval@*.md 2>/dev/null | head -1)
  if [ -n "$PWDEF" ] && grep -q "^enabled: true" "$PWDEF" 2>/dev/null; then
    if file_fresh "$HOME/workspace/watchdog/progress_state.json" 600; then
      good "progress-watchdog (Hearth) — enabled, state fresh (<10m), alerts flowing"
    elif pgrep -f "progress-watchdog" >/dev/null 2>&1; then
      good "progress-watchdog — enabled, process alive (state updating soon)"
    else
      bad "progress-watchdog — enabled but state stale and no live process (not really watching)"
    fi
  else
    warn "progress-watchdog def missing/disabled"
  fi

  # --- yote-connector-watch: :18301 must answer /health ---
  if curl -s -m 8 http://127.0.0.1:18301/health 2>/dev/null | grep -q '"ok"'; then
    good "yote-connector-watch target — :18301/health answers"
  else
    bad "yote-connector-watch target — :18301/health NOT answering (listener dead, watchdog must restart it)"
  fi

  # --- bridge-watchdog: ws_daemon alive AND real exec probe round-trips ---
  if pgrep -f "ws_daemon.py" >/dev/null 2>&1; then
    v "ws_daemon.py alive"
    if timeout 25 python3 "$HOME/workspace/awrawr-bridge/exec.py" 'echo WATCHDOG-AUDIT' 2>/dev/null | grep -q "WATCHDOG-AUDIT"; then
      good "bridge-watchdog target — ws_daemon alive + exec round-trip OK"
    else
      bad "bridge-watchdog target — daemon alive but exec probe FAILED (claims healthy, bridge dead)"
    fi
  else
    bad "bridge-watchdog target — ws_daemon.py NOT running"
  fi

  # --- kimi-auto-canary-judge: enabled while canary never executed = FAKE ---
  KJDEF=$(ls "$CROND"/kimi-auto-canary-judge__interval@*.md 2>/dev/null | head -1)
  if [ -n "$KJDEF" ] && grep -q "^enabled: true" "$KJDEF" 2>/dev/null; then
    if [ -f "$HOME/workspace/canary/phase" ] || pgrep -f "loop-canary" >/dev/null 2>&1; then
      good "kimi-auto-canary-judge — enabled and a canary exists"
    else
      bad "kimi-auto-canary-judge — ENABLED but no canary phase/process (idle loop judging nothing; remove it)"
    fi
  else
    v "kimi-auto-canary-judge not enabled (correct: canary design-only)"
  fi

  # --- race-optimizer-watchdog: enabled while target dead = FAKE ---
  RODEF=$(ls "$CROND"/race-optimizer-watchdog__interval@*.md 2>/dev/null | head -1)
  if [ -n "$RODEF" ] && grep -q "^enabled: true" "$RODEF" 2>/dev/null; then
    if pgrep -f "race-optimizer\.py" >/dev/null 2>&1; then
      good "race-optimizer-watchdog — enabled and target alive"
    else
      bad "race-optimizer-watchdog — ENABLED but race-optimizer.py dead (stale PID loop; remove it)"
    fi
  else
    v "race-optimizer-watchdog not enabled (correct: daemon killed pending rewrite)"
  fi

  # --- audit-bridge-watch: enabled only makes sense while its goal is open ---
  if grep -rl "^enabled: true" "$HOME/workspace/goals/live-nemotron-vs-kimi-herd-audit/crons/" 2>/dev/null | grep -q audit-bridge; then
    good "audit-bridge-watch — enabled, goal open, bridge-gated by design"
  else
    v "audit-bridge-watch not enabled (ok iff audit complete)"
  fi

  # --- orphan cron defs: file in cron.d/minutely not in the known set ---
  for f in "$CROND"/*.md; do
    [ -e "$f" ] || continue
    id=$(grep -m1 "^id:" "$f" | awk '{print $2}')
    case "$id" in
      progress-watchdog|swarm-watchdog|bridge-watchdog|squawk-monitor|yote-connector-watch|kimi-auto-canary-judge|audit-bridge-watch|heartbeat|race-optimizer-watchdog) v "known def: $id" ;;
      *) warn "unrecognized cron def: $f (id=$id) — needs a real probe or removal" ;;
    esac
  done
fi

########################### YOTE ###########################
if [ "$BOX" = yote ]; then
  PF=/home/toxic/.local/share/mise/installs/pitchfork/2.16.0/pitchfork
  [ -x "$PF" ] || PF=$(command -v pitchfork 2>/dev/null || echo "$PF")
  SUP_PID=$(pgrep -f "pitchfork supervisor run" | head -1)

  # --- 1. systemd watchdog units: active must show RECENT real activity ---
  for unit in fleet-watchdog-sweepd.service squawk-watchdog.service squawk-watchdog.timer; do
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
      v "$unit active"
      case "$unit" in
        fleet-watchdog-sweepd.service)
          if file_fresh /home/toxic/var/fleet-watchdog/sweepd.log 180; then
            good "$unit — active + sweep log fresh (<3m, real 60s sweeps)"
          else
            bad "$unit — active but NO recent sweep activity (fake healthy)"
          fi ;;
        squawk-watchdog.timer)
          if systemctl --user list-timers "$unit" 2>/dev/null | grep -q "squawk-watchdog.service"; then
            good "$unit — active, firing on schedule"
          else
            bad "$unit — active but not triggering its service"
          fi ;;
        *) good "$unit — active" ;;
      esac
    else
      v "$unit not active"
    fi
  done
  # squawk-watchdog.sh must probe real ports (not just exist)
  if [ -f /home/toxic/.local/share/squawk-watchdog/squawk-watchdog.sh ]; then
    if grep -q "port_open\|socket.*connect" /home/toxic/.local/share/squawk-watchdog/squawk-watchdog.sh; then
      good "squawk-watchdog.sh — does real socket probes (never restarts healthy)"
    else
      bad "squawk-watchdog.sh — no real probe found, may be fake"
    fi
  fi

  # --- 2. pitchfork claimed-vs-actual: the desync check ---
  # For every auto-start daemon: pitchfork status vs ground truth (port + /health).
  # FAKE patterns: (a) status=running but /health fails; (b) status!=running but
  # port OPEN (orphan holder pitchfork can't see — retry loop can never fix).
  if [ -z "$SUP_PID" ]; then
    bad "pitchfork supervisor NOT running — no supervision at all"
  else
    v "pitchfork supervisor pid $SUP_PID"
    cd /home/toxic/sovereign 2>/dev/null || true
    PYOUT=$(mktemp)
    if python3 - "$PF" >"$PYOUT" <<'PYEOF'
import os, re, socket, subprocess, sys, urllib.request
pf_bin = sys.argv[1]
ports = {}
try:
    for line in open("/home/toxic/sovereign/config/ports.env"):
        m = re.match(r"([A-Z0-9_]+_PORT)\s*=\s*(\d+)", line.strip())
        if m: ports[m.group(1)] = int(m.group(2))
except OSError: pass
toml = open("/home/toxic/sovereign/pitchfork.toml").read()
def pf_status(name):
    try:
        out = subprocess.run([pf_bin, "status", name], capture_output=True, text=True, timeout=15).stdout
        m = re.search(r"Status:\s*(\S+)", out)
        return m.group(1) if m else "UNKNOWN"
    except Exception:
        return "UNKNOWN"
def port_open(p):
    s = socket.socket(); s.settimeout(3)
    try: s.connect(("127.0.0.1", p)); return True
    except Exception: return False
    finally: s.close()
def health(p):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{p}/health", timeout=5) as r:
            return r.status
    except Exception:
        return None
def holder_cmd(port):
    try:
        out = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True, timeout=10).stdout
        for line in out.splitlines():
            if f":{port} " in line:
                m = re.search(r"pid=(\d+)", line)
                if m:
                    raw = open(f"/proc/{m.group(1)}/cmdline", "rb").read().decode()
                    return " ".join(raw.split("\0"))[:100]
    except Exception:
        pass
    return ""
for m in re.finditer(r"\[daemons\.([a-z0-9-]+)\](.*?)(?=\n\[daemons\.|\Z)", toml, re.S):
    name, body = m.group(1), m.group(2)
    auto = re.search(r"auto\s*=\s*(\[[^\]]*\])", body)
    if not auto or '"start"' not in auto.group(1).replace("'", '"'): continue
    dm = re.search(r'dir\s*=\s*"([^"]+)"', body)
    ddir = dm.group(1) if dm else ""
    rm = re.search(r'run\s*=\s*"([^"]+)"', body)
    runcmd = rm.group(1) if rm else ""
    st = pf_status(name)
    # broken definition: dir doesn't exist — can never start, not a desync
    if ddir and not os.path.isdir(ddir):
        print(f"BROKEN-DEF: pitchfork/{name} dir missing ({ddir}) — definition can never start")
        continue
    hm = re.search(r'ready_http\s*=\s*"http://127\.0\.0\.1:(\d+)', body)
    port = int(hm.group(1)) if hm else None
    if port is None:
        for k, v in ports.items():
            if name.replace("-", "_").upper() in k: port = v; break
    h = health(port) if port else None
    p = port_open(port) if port else False
    if st == "running" and h not in (200, None) and port:
        print(f"FAKE: pitchfork/{name} status=running but :{port}/health={h}")
    elif st == "running" and h == 200:
        print(f"REAL: pitchfork/{name} running + :{port}/health 200")
    elif st != "running" and p:
        hc = holder_cmd(port)
        # holder must look like this daemon's run command, else the ready_http is misattributed
        sig = runcmd.split()[-1] if runcmd else ""
        if sig and sig in hc:
            print(f"FAKE: pitchfork/{name} status={st} but :{port} OPEN held by own process ({hc[:60]}...) — desync")
        else:
            print(f"PORT-MISMATCH: pitchfork/{name} status={st} :{port} OPEN but held by '{hc[:60]}' not '{runcmd[:60]}' — ready_http likely wrong")
    elif st != "running":
        print(f"DOWN: pitchfork/{name} status={st} auto=start port={port} closed")
    else:
        print(f"REAL: pitchfork/{name} running (no http probe, port={port})")
PYEOF
    then
      while IFS= read -r line; do
        say "$line"
        case "$line" in FAKE:*|DOWN:*|BROKEN-DEF:*|PORT-MISMATCH:*) FAIL=1;; esac
      done <"$PYOUT"
    else
      warn "pitchfork python desync check failed to run"
    fi
    rm -f "$PYOUT"
  fi
fi

say "=== result: $([ "$FAIL" = 0 ] && echo 'ALL REAL' || echo 'FINDINGS PRESENT') ==="
exit "$FAIL"
