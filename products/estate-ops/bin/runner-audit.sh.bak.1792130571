#!/usr/bin/env bash
# runner-audit.sh — enumerate every task runner/scheduler on hatch + yote,
# check alive/claim/reality per runner, report broken/dead/duplicates in a
# table. Exit 0 = all healthy, exit 1 = findings.
#
# Durable home: sovereign/projects/ops/bin/runner-audit.sh (canonical repo
# toxicwind/sovereign-projects). Run on demand; never as a polling daemon.
#
# Design: hatch checks run locally; yote checks go through the yote-conn
# bridge (read-only probes only — this script NEVER restarts, kills, or
# modifies anything on yote; it only reports).
set -u
YOTE_CONN="${YOTE_CONN:-$HOME/workspace/bin/yote-conn}"
FAIL=0
ROWFMT="%-32s %-6s %-8s | %s\n"

row() { printf "$ROWFMT" "$1" "$2" "$3" "$4"; }
finding() { # severity, runner, detail
    FAIL=1
    printf '  [%-9s] %-28s %s\n' "$1" "$2" "$3"
}

header() { echo; echo "== $1 =="; printf "$ROWFMT" "runner" "box" "alive?" "claim / reality"; }

echo "runner-audit.sh — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=================================================================="

# ---------------------------------------------------------------- hatch: cron jobs
header "hatch: cron jobs (cron.d + system-cron.d + goal crons)"
found=0
for f in "$HOME"/workspace/cron.d/*/*.md \
         "$HOME"/workspace/system-cron.d/*/*.md \
         "$HOME"/workspace/goals/*/crons/*/*.md; do
    [ -e "$f" ] || continue
    found=$((found+1))
    id="$(awk -F': *' '/^id:/{print $2; exit}' "$f" | tr -d '\r')"
    en="$(awk -F': *' '/^enabled:/{print $2; exit}' "$f" | tr -d '\r')"
    sched="$(grep -E '^\s+(every|time|kind):' "$f" | head -3 | tr '\n' ' ' | sed 's/  */ /g')"
    state="yes"; [ "$en" = "false" ] && state="no(disabled)"
    row "$id" hatch "$state" "$sched"
done
[ "$found" -eq 0 ] && finding BROKEN "hatch cron defs" "no cron.d definitions found"

# hatch: recent-activity evidence for key watchdogs
echo
echo "== hatch: watchdog activity evidence =="
chk() { # path, max_age_s, runner
    if [ -e "$1" ]; then
        age=$(( $(date +%s) - $(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1") ))
        if [ "$age" -le "$2" ]; then
            row "$3" hatch yes "evidence file $1 touched ${age}s ago"
        else
            finding DEAD "$3" "evidence $1 stale ${age}s (limit ${2}s)"
            row "$3" hatch "STALE" "$1 touched ${age}s ago"
        fi
    else
        finding BROKEN "$3" "evidence file missing: $1"
        row "$3" hatch "no" "missing $1"
    fi
}
chk "$HOME/workspace/watchdog/progress_state.json" 600 progress-watchdog
chk "$HOME/workspace/canary/runlog.md" 900 kimi-auto-canary-judge
if [ -e "$HOME/.cache/bridge-outage-401" ]; then
    row "bridge-watchdog" hatch "yes(401)" "outage sentinel PRESENT — known token drift, circuit-broken by design"
else
    row "bridge-watchdog" hatch yes "no outage sentinel — nominal"
fi
if command -v "$HOME/workspace/bin/swarm-watchdog" >/dev/null 2>&1; then
    sw="$("$HOME/workspace/bin/swarm-watchdog" --status 2>/dev/null | head -1)"
    row "swarm-watchdog" hatch yes "status: ${sw:-unknown} (PAUSED = circuit breaker doing its job)"
else
    finding BROKEN "swarm-watchdog" "script missing at ~/workspace/bin/swarm-watchdog"
fi

# ---------------------------------------------------------------- yote: everything
header "yote: bridge reachability"
if ! "$YOTE_CONN" exec 'echo YOTE-OK' 2>/dev/null | grep -q YOTE-OK; then
    finding BROKEN "yote-conn" "bridge exec failed — all yote checks skipped"
    row "yote-bridge" yote "no" "exec failed"
    YOTEDOWN=1
else
    YOTEDOWN=0
fi

if [ "${YOTEDOWN:-0}" -eq 0 ]; then
header "yote: systemd user services + timers"
YOUT="$("$YOTE_CONN" exec '
systemctl --user is-active fleet-watchdog-sweepd.service 2>/dev/null
for t in squawk-watchdog depend-refire; do
  last=$(systemctl --user show -p LastTriggerUSec --value ${t}.timer 2>/dev/null)
  echo "${t}:$last"
done
for u in phone-lane-keeper.service phone-vitals.service ralph-dashboard.service quickshell-ii.service awrawr-mcp.service; do
  echo "$u:$(systemctl --user is-active $u 2>/dev/null)"
done
' 2>/dev/null)"
echo "$YOUT" | while IFS= read -r l; do
    case "$l" in
        fleet-watchdog-sweepd.service) : ;; # is-active printed on its own line
        active) row "fleet-watchdog-sweepd" yote yes "60s presence/rollover sweeper, flock-guarded" ;;
        inactive|failed|unknown) finding DEAD "fleet-watchdog-sweepd" "systemd state: $l" ;;
        squawk-watchdog:*) row "squawk-watchdog.timer" yote yes "squawk-ws/feed liveness; last trigger $l" ;;
        depend-refire:*) row "depend-refire.timer" yote yes "dep re-fire; last trigger $l" ;;
        *.service:active) u="${l%.service:active}"; row "$u" yote yes "systemd active" ;;
        *.service:*) u="${l%%:*}"; st="${l##*:}"; finding DEAD "$u" "systemd state: $st"; row "$u" yote "$st" "" ;;
    esac
done

header "yote: pitchfork fleet"
PLIST="$("$YOTE_CONN" exec 'PATH=$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH pitchfork list 2>/dev/null' 2>/dev/null)"
total="$(echo "$PLIST" | grep -cE '^\S+\s+\S+' || true)"
running="$(echo "$PLIST" | grep -cE 'running' || true)"
echo "pitchfork daemons: $running/$total running"
if [ "$total" -gt 0 ] && [ "$running" -lt "$total" ]; then
    finding BROKEN "pitchfork fleet" "$((total-running)) of $total daemons not running"
    echo "$PLIST" | awk '$2!="running"{print "  "$0}'
fi
dups="$(echo "$PLIST" | awk '{print $1}' | sort | uniq -d)"
[ -n "$dups" ] && finding DUPLICATE "pitchfork daemons" "duplicate daemon names: $dups"

header "yote: oracle-market loop (oracle crew's live work — report only, never touch)"
"$YOTE_CONN" exec 'ps -eo etime,cmd | grep -E "oracle_loop|market_watchdog|agents/oracle-market/bin/bidder" | grep -v grep' 2>/dev/null \
  | sed 's/^/  /'
[ "${PIPESTATUS[0]}" -ne 0 ] && finding DEAD "oracle-market" "no oracle loop procs visible"

header "yote: scheduler hygiene"
HYG="$("$YOTE_CONN" exec '
echo "crontab:$(command -v crontab >/dev/null 2>&1 && echo present || echo absent)"
echo "sweepd_procs:$(pgrep -xf "/bin/bash /home/toxic/sovereign/tools/fleet-ops/fleet-watchdog/sweepd.sh" | wc -l)"
echo "tmux:$(tmux ls 2>/dev/null | wc -l)"
' 2>/dev/null)"
crontab_st="$(echo "$HYG" | awk -F: '/^crontab:/{print $2}')"
swn="$(echo "$HYG" | awk -F: '/^sweepd_procs:/{print $2}' | tr -d ' ')"
tmn="$(echo "$HYG" | awk -F: '/^tmux:/{print $2}' | tr -d ' ')"
row "crontab" yote "$crontab_st" "expect: absent (no cron on yote by design)"
if [ "$swn" = "1" ]; then row "sweepd.sh procs" yote yes "1 instance (flock-guarded), nominal"
elif [ "$swn" = "0" ]; then finding DEAD "fleet-watchdog-sweepd" "sweepd.sh not in process list (unit claims otherwise?)"
else finding DUPLICATE "fleet-watchdog-sweepd" "$swn sweepd.sh processes — flock failed?"; fi
row "tmux sessions" yote "-" "$tmn transient agent sessions (not runners)"
fi

# ---------------------------------------------------------------- known distinct pairs (never flag as dupes)
echo
echo "== verified distinct pairs (not duplicates) =="
printf '  %-28s %-28s %s\n' "progress-watchdog (hatch 3m)" "fleet-watchdog-sweepd (yote 60s)" "supervisor vs presence heartbeat"
printf '  %-28s %-28s %s\n' "bridge-watchdog (hatch 5m)" "yote-connector-watch (hatch 5m)" "yote WS vs cell listener :18301"
printf '  %-28s %-28s %s\n' "progress-watchdog (hatch)" "sovereign/market-watchdog" "fleet supervisor vs inotify bidder-only restart"

# ---------------------------------------------------------------- summary
echo
echo "=================================================================="
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: HEALTHY — no broken/dead/duplicate runners found."
    exit 0
else
    echo "RESULT: FINDINGS — see [BROKEN]/[DEAD]/[DUPLICATE] rows above."
    exit 1
fi
