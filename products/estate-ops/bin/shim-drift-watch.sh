#!/usr/bin/env bash
# shim-drift-watch — event-driven drift sentinel for the sidechat shim.
# Watches both canonical shim copies with inotify; on any close_write /
# moved_to, runs shim-drift-sentinel.py and logs the verdict. No polling:
# the kernel wakes us only when a shim file actually changes.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SENTINEL="${SHIM_SENTINEL:-$HERE/shim-drift-sentinel.py}"
LOG="${SHIM_DRIFT_LOG:-$HOME/.local/state/shim-drift.log}"
FILES="${SHIM_WATCH_FILES:-/home/toxic/hatch/sidechat_shim.py /home/toxic/kite/kite/sidechat_shim.py}"
mkdir -p "$(dirname "$LOG")"
echo "$(date -Is) watch start: $FILES" >> "$LOG"
# shellcheck disable=SC2086
inotifywait -m -e close_write -e moved_to --format '%w%f %e' $FILES \
| while read -r path ev; do
    verdict="$(python3 "$SENTINEL" 2>&1)"
    line="$(date -Is) $ev $path -> $verdict"
    echo "$line" >> "$LOG"
    echo "$line"
  done
