#!/usr/bin/env bash
# floaty-hud — the compact always-available floaty HUD for the agent-desktop.
# Shows the stoplight + current controllable-desktop state in a small floating
# terminal, hidden when idle (blank/off when nothing needs the human), floats
# with the human + agent's state. Lives in a Hyprland floating window.
set -uo pipefail
export WAYLAND_DISPLAY=wayland-1
export XDG_RUNTIME_DIR=/run/user/1000
clear
printf '\033[1;36m  ∞  FLOATY  —  agent-controllable desktop  \033[0m\n'
printf '\033[36m─────────────────────────────────────────\033[0m\n'
while true; do
  # live stoplight (idle->green, waiting->red needs-you, busy->yellow)
  lamp=$(curl -s --max-time 3 http://127.0.0.1:4747/state 2>/dev/null | grep -o '"overall":"[a-z]*"' | cut -d'"' -f4)
  case "$lamp" in
    waiting) col='\033[31m'; sym='●'; ;;
    busy)    col='\033[33m'; sym='●'; ;;
    idle)    col='\033[32m'; sym='●'; ;;
    *)       col='\033[2m';  sym='○'; lamp=off; ;;
  esac
  agents=$(curl -s --max-time 3 http://127.0.0.1:4747/state 2>/dev/null | grep -o '"agent":"[^"]*"' | cut -d'"' -f4 | head -1)
  win_count=$(hyprctl clients -j 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo '?')
  desk=$(ls /tmp/floaty/desktop.png 2>/dev/null && stat -c'%y' /tmp/floaty/desktop.png 2>/dev/null | cut -d' ' -f1,2 || echo 'no capture yet')
  printf '\r  %b%s%b agent:%-10s  windows:%-3s  desk:@%s ' "$col" "$sym" "\033[0m" "${agents:-<none>}" "$win_count" "$desk"
  printf '\033[K'
  sleep 1
done