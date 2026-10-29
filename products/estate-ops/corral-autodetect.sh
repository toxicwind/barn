#!/usr/bin/env bash
# corral-autodetect.sh
# Auto-detect corral-diag.sh hang/polling issues.
# Usage:
#   corral-autodetect.sh                 # find corral-diag.sh, sample 5s
#   corral-autodetect.sh corral-diag.sh 10
#   corral-autodetect.sh strace-detail.txt
set -u

MODE="live"
TARGET="${1:-corral-diag.sh}"
SAMPLE="${2:-5}"

if [[ -f "$TARGET" && "$TARGET" =~ strace|trace ]]; then
  MODE="file"
  TRACE="$TARGET"
  OUT="/tmp/corral-autodetect.$$"
  mkdir -p "$OUT"
else
  OUT="/tmp/corral-autodetect.$$"
  mkdir -p "$OUT"
  TRACE="$OUT/trace.txt"
fi

log(){ printf '\n=== %s ===\n' "$*"; }

parse_trace() {
  local trace="$1"
  log "Top syscalls"
  awk '
    /^[0-9]+[[:space:]]+[0-9:.]+[[:space:]]+/ {
      for(i=1;i<=NF;i++) if ($i ~ /\(/) { sys=$i; sub(/\(.*/,"",sys); c[sys]++; break }
    }
    END{ for(s in c) print c[s], s }
  ' "$trace" | sort -nr | head -20

  log "Top exact repeated operations"
  sed -E '
    s/^[0-9]+[[:space:]]+[0-9:.]+[[:space:]]+//
    s/[[:space:]]+<[^>]*>.*$//
    s/[[:space:]]+=.*$//
  ' "$trace" | sort | uniq -c | sort -nr | head -25

  log "Hypothesis hits"
  awk '
    /^[0-9]+[[:space:]]+[0-9:.]+[[:space:]]+/ {
      pid=$1
      line=$0
      sub(/^[0-9]+[[:space:]]+[0-9:.]+[[:space:]]+/,"",line)
      c[pid" "line]++
      if (line ~ /pread64\(6, "1949015/ || line ~ /\/proc\/stat/ || line ~ /pread64\(.*256, 0\)/) h1[pid]++
      if (line ~ /futex\(.*FUTEX_WAIT/) h2[pid]++
      if (line ~ /epoll_wait/) h3[pid]++
      if (line ~ /read\(.*EAGAIN/) h4[pid]++
      if (line ~ /nanosleep|clock_nanosleep/) h5[pid]++
    }
    END{
      for(k in c) if(c[k]>30) print "REPEAT", c[k], k
      for(p in h1) print "H1_TIGHT_PROC_STAT", p, h1[p]
      for(p in h2) print "H2_FUTEX_WAIT", p, h2[p]
      for(p in h3) print "H3_EPOLL_WAIT", p, h3[p]
      for(p in h4) print "H4_NONBLOCK_EAGAIN", p, h4[p]
      for(p in h5) print "H5_SLEEP_PRESENT", p, h5[p]
    }
  ' "$trace" | sort -k2,2nr | head -60

  log "Auto verdict"
  if grep -Eq 'pread64\(6, "1949015|/proc/stat' "$trace"; then
    cat <<'EOF'
H1: Tight loop on /proc/stat (or similar /proc file) detected.
    Likely: while true; do cat /proc/stat; done
    or top/vmstat/mpstat/pidstat/sar/iostat called without sleep.
    Fix: add sleep N, use sampling interval, or remove loop.
EOF
  fi
  if grep -Eq 'FUTEX_WAIT' "$trace" && ! grep -Eq 'FUTEX_WAKE' "$trace"; then
    echo "H2: Futex wait without matching wake in sample. Possible lock contention/deadlock; sample longer."
  fi
  if grep -Eq 'epoll_wait' "$trace"; then
    echo "H3: epoll_wait present. Usually normal event loop waiting, not a hang by itself."
  fi
  if grep -Eq 'EAGAIN' "$trace"; then
    echo "H4: Non-blocking EAGAIN present. Usually normal, but can indicate busy polling."
  fi
  if ! grep -Eq 'nanosleep|clock_nanosleep|select|poll\(|epoll_wait' "$trace"; then
    echo "H5: No sleep/poll/select in sample. Busy loop is likely."
  fi
}

if [[ "$MODE" == "file" ]]; then
  log "Parsing existing trace: $TRACE"
  parse_trace "$TRACE"
  exit 0
fi

log "Finding target: $TARGET"
mapfile -t PIDS < <(pgrep -f "$TARGET" 2>/dev/null || true)
if ((${#PIDS[@]}==0)); then
  echo "No process matching '$TARGET'"
  echo "Try: pgrep -af corral"
  exit 1
fi
ROOT="${PIDS[0]}"

log "Process tree"
pstree -aps "$ROOT" 2>/dev/null || ps -ef --forest | grep -E "$TARGET|corral" | grep -v grep

for pid in "${PIDS[@]}"; do
  [[ -d /proc/$pid ]] || continue
  log "PID $pid"
  ps -o pid,ppid,pgid,sid,stat,pcpu,pmem,wchan:32,etime,cmd -p "$pid" 2>/dev/null
  echo "State: $(grep -E '^State:' /proc/$pid/status 2>/dev/null)"
  echo "Threads: $(grep -E '^Threads:' /proc/$pid/status 2>/dev/null)"
  echo "wchan: $(cat /proc/$pid/wchan 2>/dev/null)"
  echo "cmdline: $(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)"
  FDTARGET=$(readlink /proc/$pid/fd/6 2>/dev/null || true)
  echo "fd 6: $FDTARGET"
  if [[ "$FDTARGET" == "/proc/stat" ]]; then
    echo "H1: fd 6 points to /proc/stat"
  fi
  echo "children:"
  pgrep -P "$pid" -a 2>/dev/null || true
done

log "Monitor suspects in process tree"
ps -eo pid,ppid,stat,pcpu,wchan:24,cmd | \
  grep -E 'top|vmstat|mpstat|pidstat|sar|iostat|watch|free|uptime|/proc/stat|cat[[:space:]]+/proc/stat' | \
  grep -v grep || echo "none found"

log "CPU burn check"
ps -eo pid,ppid,pcpu,stat,cmd --sort=-pcpu | head -15

log "strace sampling root PID $ROOT for ${SAMPLE}s"
timeout "$SAMPLE" strace -f -tt -T -s 160 -o "$TRACE" -p "$ROOT" 2>"$OUT/strace.err" || true
if [[ -s "$OUT/strace.err" ]]; then
  echo "strace stderr:"
  head -5 "$OUT/strace.err"
fi

if [[ ! -s "$TRACE" ]]; then
  echo "No trace captured. Need ptrace permission? Try sudo, or check /proc/sys/kernel/yama/ptrace_scope."
  exit 0
fi

parse_trace "$TRACE"

log "Artifacts"
echo "Trace: $TRACE"
echo "strace stderr: $OUT/strace.err"
