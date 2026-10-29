#!/usr/bin/env bash
# pixel-adb-keepalive — hold the Pixel's adb session over LAN wireless debugging.
#
# One-time pairing (done 2026-09-17): phone's "Pair with pairing code" screen ->
#   adb pair 10.0.0.77:<pair-port> (code from screen). Pairing persists in
#   ~/.android/adbkey* on awrawr-pc; no USB needed, survives phone reboot
#   (wireless debugging stays on). The *connect* port can rotate if wireless
#   debugging is toggled — the loop below rediscovers it via fast port scan.
#
# Replaces the old Tailscale tcpip target (100.123.57.58:5555, dropped
# 2026-09-17 per Chris: "new one drop other"). Additive only: never touches
# other adb devices (emulator-5554 etc.).
set -u
PIXEL_IP="10.0.0.77"
KNOWN_PORT="43585"
TARGET="${PIXEL_IP}:${KNOWN_PORT}"
ISLEEP="/home/toxic/bin/isleep"
ADB="/usr/bin/adb"
# Drop any stale entry for the retired Tailscale target, once per loop is cheap.
STALE="100.123.57.58:5555"
discover() {
  python3 - "$PIXEL_IP" <<'PYEOF'
import socket, sys
from concurrent.futures import ThreadPoolExecutor
ip = sys.argv[1]
def probe(p):
    s = socket.socket(); s.settimeout(0.3)
    try:
        s.connect((ip, p)); s.close(); return p
    except Exception:
        return None
with ThreadPoolExecutor(400) as ex:
    for r in ex.map(probe, range(30000, 50000)):
        if r: print(r)
PYEOF
}
pixel_live() {
  "${ADB}" devices 2>/dev/null | grep -qE "^${PIXEL_IP}:[0-9]+[[:space:]]+device"
}
while true; do
  "${ADB}" disconnect "${STALE}" >/dev/null 2>&1 || true
  if ! pixel_live; then
    if "${ADB}" connect "${TARGET}" 2>&1 | grep -q "connected to"; then
      :
    else
      "${ADB}" disconnect "${TARGET}" >/dev/null 2>&1 || true
      for p in $(discover); do
        cand="${PIXEL_IP}:${p}"
        if "${ADB}" connect "${cand}" 2>&1 | grep -q "connected to"; then
          TARGET="${cand}"
          break
        else
          "${ADB}" disconnect "${cand}" >/dev/null 2>&1 || true
        fi
      done
    fi
  fi
  "${ISLEEP}" 60 --name pixel-adb-keepalive || break
done
