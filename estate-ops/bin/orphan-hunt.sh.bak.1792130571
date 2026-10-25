#!/usr/bin/env bash
# orphan-hunt.sh — find detached PIDs, stale pid/lock files, zombie tmux sessions,
# dead-but-"running" daemons on hatch and yote. Every finding carries a suggested
# disposition: CLEAN (safe to remove) or ADOPT (document/keep deliberately).
#
# Runs on EITHER box; auto-detects hatch vs yote by filesystem.
#   ./orphan-hunt.sh            # report only
#   ./orphan-hunt.sh --verbose  # show every check
# Exit 0 = no orphans. Exit 1 = findings present.
#
# It never kills anything and never deletes anything — it reports. The one
# exception-free rule: /tmp is Trench's lane; this script lists but does not
# triage /tmp contents.
#
# Permanent home: sovereign-projects/projects/ops/bin/
# First run: 2026-09-20 (watchdog-hunter) — cleaned 10 stale yote pidfiles,
# 1 stale hatch race-optimizer.pid; adopted tau-lab tmux (owner unknown, idle).
set -u
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

FAIL=0
say() { printf '%s\n' "$*"; }
v()   { [ "$VERBOSE" = 1 ] && say "  check: $*"; }
found(){ say "$1: $2 -- suggest: $3"; FAIL=1; }
ok()  { [ "$VERBOSE" = 1 ] && say "OK: $*"; }

BOX=unknown
[ -d /home/toxic/sovereign ] && BOX=yote
[ -d /home/hatch/workspace/cron.d ] && BOX=hatch
say "=== orphan-hunt on $BOX ($(date -u +%FT%TZ)) ==="

pid_alive() { kill -0 "$1" 2>/dev/null; }
cmd_of()    { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | cut -c1-120; }

########################### pidfiles (both boxes) ###########################
scan_pidfiles() { # scan_pidfiles <root> <maxdepth>
  v "scanning $1 for *.pid (depth $2)"
  find "$1" -maxdepth "$2" -name '*.pid' 2>/dev/null | while read -r pf; do
    # never triage /tmp contents (Trench's lane) — list only
    case "$pf" in /tmp/*) say "SKIP-TRIAGE: $pf (in /tmp, Trench's lane)"; continue;; esac
    pid=$(tr -d ' \n' < "$pf" 2>/dev/null | head -c 16)
    if [ -z "$pid" ]; then
      found "STALE-EMPTY" "$pf (0-byte pidfile, no process ever)" "CLEAN: rm $pf"
    elif ! pid_alive "$pid"; then
      found "STALE" "$pf -> pid $pid (dead)" "CLEAN: rm $pf"
    else
      # PID alive — is it the right process? check cmdline mentions the pidfile's dir hint
      ok "$pf -> pid $pid alive ($(cmd_of "$pid"))"
    fi
  done
}

if [ "$BOX" = hatch ]; then
  scan_pidfiles "$HOME/.cache" 3
  scan_pidfiles "$HOME/workspace" 3
  # stray detached shells from daemon restarts (ppid=1, sleeping, known patterns)
  v "looking for stray detached restart shells"
  ps -eo pid,ppid,stat,args 2>/dev/null | awk '$2==1 && $0 ~ /connector\.pid|nohup/ {print}' | while read -r line; do
    found "DETACHED-SHELL" "$line" "CLEAN: kill after verifying child detached (ps -o pid,ppid,sid -p <child>)"
  done
  # cron def orphans: an _archive copy that claims enabled:true is only a finding
  # if no ACTIVE def with the same id exists (else it's just pre-migration history)
  for f in "$HOME/workspace/cron.d/_archive"/*.md; do
    [ -e "$f" ] || continue
    grep -q "^enabled: true" "$f" 2>/dev/null || continue
    aid=$(grep -m1 "^id:" "$f" | awk '{print $2}')
    [ -n "$aid" ] || continue
    if grep -rl "^id: $aid$" "$HOME/workspace/cron.d/minutely" "$HOME/workspace/cron.d/hourly" "$HOME/workspace/goals" 2>/dev/null | grep -v "_archive" | grep -q .; then
      ok "_archive/$aid enabled:true but active def exists (history, harmless)"
    else
      found "ARCHIVED-ENABLED" "$f (claims enabled, no active def with id=$aid)" "ADOPT: re-add via cron tool or set enabled:false"
    fi
  done
fi

if [ "$BOX" = yote ]; then
  scan_pidfiles /home/toxic 4
  # lock files that outlived their holder — only top-level daemon locks + system lock dirs
  # (deep scans of project trees are all build-manifest noise: Cargo.lock, uv.lock, etc.)
  v "scanning for stale daemon .lock files"
  { ls -d /home/toxic/*.lock /home/toxic/.*.lock /run/*.lock /var/lock/* 2>/dev/null; } \
    | grep -vE "/(Cargo\.lock|flake\.lock|uv\.lock|bun\.lock|package-lock\.json|poetry\.lock|Gemfile\.lock|composer\.lock)$" \
    | while read -r lf; do
    [ -f "$lf" ] || continue
    if [ -n "$(find "$lf" -mmin +120 2>/dev/null)" ]; then
      if fuser "$lf" >/dev/null 2>&1; then
        ok "$lf has a live holder"
      else
        found "STALE-LOCK" "$lf (untouched >2h, no holder)" "CLEAN: rm $lf"
      fi
    fi
  done
fi

########################### tmux (yote) ###########################
if [ "$BOX" = yote ] && command -v tmux >/dev/null 2>&1; then
  v "listing tmux sessions"
  tmux ls 2>/dev/null | while read -r sess; do
    sname=$(echo "$sess" | cut -d: -f1)
    panes=$(tmux list-panes -t "$sname" -F "#{pane_current_command}" 2>/dev/null | sort -u | tr '\n' ' ')
    case "$panes" in
      *"bash "*|*"sh "*)
        # all panes are shells — idle or lab? show paths for the human call
        paths=$(tmux list-panes -t "$sname" -F "#{pane_current_path}" 2>/dev/null | sort -u | tr '\n' ' ')
        found "IDLE-TMUX" "session '$sname' panes=[$panes] paths=[$paths]" "ADOPT: document owner/purpose; CLEAN only if owner confirms (never blind-kill a lab session)"
        ;;
      *) ok "tmux '$sname' panes=[$panes] (has live programs)" ;;
    esac
  done
fi

########################### zombies (both) ###########################
v "looking for zombie processes"
zombies=$(ps -eo stat,comm 2>/dev/null | awk '$1 ~ /Z/ {print $2}' | sort -u | head -5)
if [ -n "$zombies" ]; then
  found "ZOMBIES" "$(echo "$zombies" | tr '\n' ' ') (parent not reaping)" "ADOPT: fix parent; CLEAN only via parent restart"
else
  ok "no zombies"
fi

########################### yote: port holders vs pitchfork ###########################
if [ "$BOX" = yote ]; then
  SUP_PID=$(pgrep -f "pitchfork supervisor run" | head -1)
  v "pitchfork supervisor pid: ${SUP_PID:-none}"
  if [ -n "$SUP_PID" ]; then
    # every _PORT in ports.env: who holds it, and is the holder under pitchfork?
    grep -oE "^[A-Z0-9_]+_PORT=[0-9]+" /home/toxic/sovereign/config/ports.env 2>/dev/null | while IFS='=' read -r k p; do
      holder=$(ss -ltnp 2>/dev/null | grep -m1 ":$p " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
      [ -z "$holder" ] && continue
      # walk up: is pitchfork supervisor an ancestor?
      anc=$holder; under_pf=0
      for _ in 1 2 3 4 5 6 7 8; do
        anc=$(ps -o ppid= -p "$anc" 2>/dev/null | tr -d ' ')
        [ -z "$anc" ] && break
        if [ "$anc" = "$SUP_PID" ]; then under_pf=1; break; fi
      done
      if [ "$under_pf" = 0 ]; then
        # not a pitchfork child — but it may be legit infra (tailscaled, sshd...). Report.
        found "ORPHAN-PORT" ":$p ($k) held by pid $holder ($(cmd_of "$holder")) not under pitchfork" "ADOPT: register in pitchfork.toml if it belongs; CLEAN (kill) only if unknown squatter"
      else
        ok ":$p held by pitchfork child $holder"
      fi
    done
    # dead-but-expected: auto=start daemons pitchfork reports as not running
    PF=/home/toxic/.local/share/mise/installs/pitchfork/2.16.0/pitchfork
    [ -x "$PF" ] || PF=$(command -v pitchfork 2>/dev/null)
    if [ -n "$PF" ]; then
      cd /home/toxic/sovereign 2>/dev/null || true
      grep -oE "^\[daemons\.[a-z0-9-]+\]" pitchfork.toml 2>/dev/null | sed 's/\[daemons\.//;s/\]//' | while read -r d; do
        body=$(awk "/^\[daemons\.$d\]/{f=1} f&&/^\[daemons\./&&!/^\[daemons\.$d\]/{exit} f" pitchfork.toml)
        echo "$body" | grep -q '"start"' || continue
        st=$("$PF" status "$d" 2>/dev/null | grep -m1 "Status:" | awk '{print $2}')
        if [ "$st" != "running" ]; then
          found "DOWN-EXPECTED" "pitchfork/$d status=$st but auto=[start]" "ADOPT: bin/pitchfork-restart sovereign/$d (if wanted) or remove auto=start (if retired)"
        fi
      done
    fi
  else
    found "NO-SUPERVISOR" "pitchfork supervisor not running" "ADOPT: start it (pitchfork supervisor start --boot) or document why down"
  fi
fi

say "=== result: $([ "$FAIL" = 0 ] && echo 'NO ORPHANS' || echo 'FINDINGS PRESENT') ==="
exit "$FAIL"
