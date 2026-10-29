#!/usr/bin/env bash
# pitchfork-binding-watch -- event-driven tracking-loss sentinel.
# Watches pitchfork's state DIRECTORY with inotify; the supervisor
# persists state by atomic rename (create state.toml.tmp -> write ->
# rename over state.toml), so a file-level watch goes deaf after the
# first save -- the watch must live on the directory and key on the
# rename landing. On every state.toml MOVED_TO, runs
# pitchfork-binding-sentinel.py, which verifies the binding of every
# allowlisted singleton daemon against the live process table and
# heals tracking loss (orphan running, binding errored/missing) with
# the stop -> terminate orphan -> start-tracked sequence.
# No polling: the kernel wakes us only when the state file changes.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SENTINEL="${PFB_SENTINEL:-$HERE/pitchfork-binding-sentinel.py}"
LOG="${PFB_LOG:-$HOME/.local/state/pitchfork-binding.log}"
STATE_FILE="${PITCHFORK_STATE:-$HOME/.local/state/pitchfork/state.toml}"
STATE_DIR="$(dirname "$STATE_FILE")"
mkdir -p "$(dirname "$LOG")"
echo "$(date -Is) watch start: $STATE_FILE (dir watch, rename-keyed)" >> "$LOG"
# One check at startup: a loss that happened while the watch was
# down is healed on boot, not on the next transition.
python3 "$SENTINEL" --auto >> "$LOG" 2>&1
last=0
inotifywait -m -e moved_to -e close_write --format '%e %f' "$STATE_DIR" \
| while read -r ev file; do
    [ "$file" = "state.toml" ] || continue
    now=$(date +%s)
    # Coalesce bursts: transitions land in clusters; one sentinel
    # pass per 2s covers the whole cluster.
    [ $((now - last)) -lt 2 ] && continue
    last=$now
    python3 "$SENTINEL" --auto >> "$LOG" 2>&1
  done
