#!/usr/bin/env bash
# floaty-controller — the agent's full-desktop control surface.
# The agent "sees" the real desktop (full-screen capture of all Hyprland
# monitors) and "acts" on it (activate windows, inject input) — all without
# stealing the human's mouse (they take over in Hyprland at any time). Runs
# on the live Wayland compositor. Part of the floaty-desktop stack.
#
# usage:
#   floaty-controller see          # capture all monitors to /tmp/floaty/desktop.png
#   floaty-controller windows      # list window class+title+at (what the agent can target)
#   floaty-controller focus CLASS  # hyprctl dispatch focuswindow class:CLASS
#   floaty-controller activate WINDOWID  # focus by id
#   floaty-controller type TEXT    # wtype: type into the focused window
#   floaty-controller stoplight STATE  # agent-needs-user signal: waiting|busy|idle
set -uo pipefail
export WAYLAND_DISPLAY=wayland-1
export XDG_RUNTIME_DIR=/run/user/1000
STORE=/tmp/floaty
mkdir -p "$STORE"
CMD="${1:-see}"
case "$CMD" in
  see)
    grim -l 1 "$STORE/desktop.png" 2>/dev/null && echo "desktop.png $(stat -c%s "$STORE/desktop.png") bytes ($(file -b "$STORE/desktop.png" | cut -d, -f1-2))" || echo "capture failed"
    ;;
  windows)
    hyprctl clients -j 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d:
    if isinstance(c,dict): print(f\"{c.get('at')} {c.get('size')} {c.get('class')}: {c.get('title','')[:50]}\")
" 2>/dev/null | head -20
    ;;
  focus)
    hyprctl dispatch "hl.dsp.focus({window=\"class:$2\"})" 2>&1 && echo "focused $2"
    ;;
  activate)
    hyprctl dispatch "hl.dsp.focus({window=\"address:$2\"})" 2>&1 && echo "activated $2"
    ;;
  type)
    shift; wtype -M ctrl -k l 2>/dev/null; printf '%s' "$*" | wtype - 2>/dev/null && echo "typed"
    ;;
  stoplight)
    /usr/bin/node /home/toxic/pens/ranch/signalhead/src/cli.js set "${2:-idle}" --agent desk 2>/dev/null | tail -1
    curl -s --max-time 4 http://127.0.0.1:4747/state 2>/dev/null | head -c 90; echo
    ;;
  *)
    echo "unknown: $CMD";;
esac