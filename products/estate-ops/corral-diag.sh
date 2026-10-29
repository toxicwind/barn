#!/usr/bin/env bash
# corral-diag.sh v2 — target the real corral/smithers/ralph/omp ecosystem.
# v2 fixes:
#   - Excludes its own pid + pgid (v1 matched itself on 'corral')
#   - Matches by resolved exe path, not cmdline substring
#   - Reads ~/.smithers/executions/ (real workflow state)
#   - Accepts explicit PID as $1; otherwise finds newest omp child
set -uo pipefail

SELF=$$
SELF_PGID=$(ps -o pgid= -p $SELF | tr -d ' ')
OUTDIR="/tmp/corral-diag-$(date +%Y%m%dT%H%M%S)"
DURATION="${DURATION:-10}"
OMP_BIN="/home/toxic/estate/projects/range/ranch/stockyard/tau/packages/coding-agent/dist/omp"
mkdir -p "$OUTDIR"

log(){ printf '[%s] %s\n' "$(date +%T)" "$*" | tee -a "$OUTDIR/diag.log" >&2; }

# ── exclusions: never target self, self's pgid, or known noise ───────────
is_self(){
  local p="$1"
  [[ "$p" == "$SELF" ]] && return 0
  local pgid; pgid=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
  [[ "$pgid" == "$SELF_PGID" ]] && return 0
  local exe; exe=$(readlink /proc/$p/exe 2>/dev/null)
  [[ "$exe" == */bash || "$exe" == */sed || "$exe" == */grep || "$exe" == */pgrep ]] && return 0
  return 1
}

# ── find target: explicit pid arg, else newest omp under corral chain ────
find_target(){
  if [[ -n "${1:-}" && -d "/proc/$1" ]]; then
    echo "$1"; return 0
  fi
  # Prefer: omp processes whose exe resolves to OMP_BIN
  local best="" best_age=999999
  for p in $(pgrep -f 'dist/omp' 2>/dev/null); do
    is_self "$p" && continue
    local exe; exe=$(readlink /proc/$p/exe 2>/dev/null) || continue
    [[ "$exe" == "$OMP_BIN" ]] || continue
    # age in seconds from /proc/$p/stat starttime
    local st; st=$(stat -c %Y /proc/$p 2>/dev/null || echo 0)
    local age=$(( $(date +%s) - st ))
    if (( age < best_age )); then best_age=$age; best="$p"; fi
  done
  [[ -n "$best" ]] && { echo "$best"; return 0; }
  return 1
}

# ── walk the full tree (ancestors + descendants) of a pid ────────────────
walk_tree(){
  local p="$1" out="$2"
  : >"$out"
  # ancestors
  local a="$p"
  while [[ "$a" != "1" && -d "/proc/$a" ]]; do
    echo "$a" >>"$out"
    a=$(awk '{print $4}' /proc/$a/stat 2>/dev/null)
    [[ -z "$a" ]] && break
  done
  # descendants (BFS)
  local queue="$p"
  while [[ -n "$queue" ]]; do
    local next=""
    for c in $queue; do
      echo "$c" >>"$out"
      for k in $(pgrep -P "$c" 2>/dev/null); do
        is_self "$k" || next="$next $k"
      done
    done
    queue="$next"
  done
  sort -u "$out" -o "$out"
}

# ── main ─────────────────────────────────────────────────────────────────
TARGET=$(find_target "${1:-}" || true)
if [[ -z "$TARGET" ]]; then
  log "no omp process found."
  log "start corral, then re-run:  corral \"...\" --skip-questions &  ;  ~/bin/corral-diag.sh"
  # still capture artifacts
  {
    echo "== smithers executions =="
    ls -lt ~/.smithers/executions/ 2>/dev/null | head -20
    echo
    echo "== recent ralph/smithers state =="
    find ~/.smithers ~/.ralph ~/.cache/ralph-workflow -type f -mmin -120 2>/dev/null | head -20
  } | tee "$OUTDIR/05-artifacts.txt"
  exit 0
fi

log "outdir:   $OUTDIR"
log "target:   $TARGET"
log "duration: ${DURATION}s"

walk_tree "$TARGET" "$OUTDIR/tree-pids.txt"
log "tree pids: $(wc -l <"$OUTDIR/tree-pids.txt") ($(tr '\n' ' ' <"$OUTDIR/tree-pids.txt"))"

# process tree snapshot
{
  echo "== tree (target=$TARGET) =="
  while read -r p; do
    [[ -d "/proc/$p" ]] || continue
    printf '  pid=%-8s ppid=%-8s %s\n' "$p" \
      "$(awk '{print $4}' /proc/$p/stat 2>/dev/null)" \
      "$(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | head -c 140)"
  done <"$OUTDIR/tree-pids.txt"
} >"$OUTDIR/01-tree.txt"
log "tree captured"

# fd inventory for each pid
{
  while read -r p; do
    [[ -d "/proc/$p" ]] || continue
    echo "== pid=$p $(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | head -c 100) =="
    for fd in /proc/$p/fd/*; do
      [[ -e "$fd" ]] || continue
      printf '  %s -> %s\n' "$(basename "$fd")" "$(readlink "$fd" 2>/dev/null)"
    done
    echo "  -- type summary --"
    for fd in /proc/$p/fd/*; do
      [[ -e "$fd" ]] || continue
      readlink "$fd" 2>/dev/null
    done | sed -E 's/socket:\[[0-9]+\]/socket:[*]/; s/pipe:\[[0-9]+\]/pipe:[*]/; s/anon_inode:\[([a-z]+)\]/\1/' \
      | sort | uniq -c | sort -rn | awk '{print "  "$0}'
    echo
  done <"$OUTDIR/tree-pids.txt"
} >"$OUTDIR/02-fds.txt"
log "fds captured"

# strace on the whole tree
PIDS=$(tr '\n' ',' <"$OUTDIR/tree-pids.txt" | sed 's/,$//')
if [[ -n "$PIDS" ]]; then
  log "strace on: $PIDS (${DURATION}s)"
  timeout "$DURATION" strace -f -c -p "$PIDS" -o "$OUTDIR/strace-summary.txt" 2>/dev/null || true
  timeout "$DURATION" strace -f -tt -T \
    -e trace=pread64,pwrite64,read,write,openat,unlink,fsync,fdatasync,futex,epoll_wait,connect \
    -s 256 -o "$OUTDIR/strace-detail.txt" -p "$PIDS" 2>/dev/null || true
  log "strace summary: $(wc -l <"$OUTDIR/strace-summary.txt" 2>/dev/null || echo 0) lines"
fi

# corral/smithers/ralph artifacts + smithers executions dir
{
  echo "== smithers executions =="
  ls -lt ~/.smithers/executions/ 2>/dev/null | head -20
  echo
  echo "== ralph state =="
  ls -lt ~/.ralph/ 2>/dev/null | head -10
  echo
  echo "== ralph-workflow cache =="
  ls -lt ~/.cache/ralph-workflow/ 2>/dev/null | head -10
  echo
  echo "== workflow files in cwd =="
  ls -lt ./*.md 2>/dev/null | head -10
} >"$OUTDIR/05-artifacts.txt"

# smithers execution state (the real workflow generator state)
{
  echo "== newest smithers execution =="
  newest=$(ls -1t ~/.smithers/executions/ 2>/dev/null | head -1)
  if [[ -n "$newest" ]]; then
    echo "  exec: $newest"
    ls -la ~/.smithers/executions/"$newest" 2>/dev/null | sed 's/^/    /'
    for f in state.json workflow.json questions.json run.json; do
      [[ -f ~/.smithers/executions/"$newest"/$f ]] && {
        echo "    --- $f ---"
        head -40 ~/.smithers/executions/"$newest"/$f | sed 's/^/      /'
      }
    done
  else
    echo "  (no executions)"
  fi
} >"$OUTDIR/06-workflow-state.txt"

# ── report ───────────────────────────────────────────────────────────────
{
  echo "══ corral diagnostic v2 ══"
  echo "target: $TARGET"
  echo "outdir: $OUTDIR"
  echo
  echo "── 1. process tree (ancestors + descendants) ──"
  cat "$OUTDIR/01-tree.txt" 2>/dev/null
  echo
  echo "── 2. fd types per process ──"
  head -120 "$OUTDIR/02-fds.txt" 2>/dev/null
  echo
  echo "── 3. strace syscall summary ──"
  tail -30 "$OUTDIR/strace-summary.txt" 2>/dev/null
  echo
  echo "── 4. strace detail (first 30) ──"
  head -30 "$OUTDIR/strace-detail.txt" 2>/dev/null
  echo
  echo "── 5. corral/smithers/ralph artifacts ──"
  cat "$OUTDIR/05-artifacts.txt" 2>/dev/null
  echo
  echo "── 6. workflow generator state ──"
  cat "$OUTDIR/06-workflow-state.txt" 2>/dev/null
  echo
  echo "── 7. hot pids (sample of utime+stime) ──"
  while read -r p; do
    [[ -d "/proc/$p" ]] || continue
    awk -v p="$p" '{printf "  pid=%s utime=%s stime=%s state=%s\n", p, $14, $15, $3}' /proc/$p/stat 2>/dev/null
  done <"$OUTDIR/tree-pids.txt" | sort -t= -k2 -nr | head -15
} | tee "$OUTDIR/CORRAL-REPORT.txt"

log "done. report: $OUTDIR/CORRAL-REPORT.txt"
