#!/bin/bash
# tunnel-monitor.sh — yote-side circuit breaker for the cell reverse tunnel.
# Checks that yote's squawk server can reach cell-primary through the tunnel.
# If the tunnel is down, restarts the tunnel client on the cell via yote-conn.
# Runs as a pitchfork daemon on yote (estate/squawk-tunnel-monitor).

HEALTH_URL="http://127.0.0.1:25136/fleet/health"
YOTE_CONN="/home/hatch/workspace/bin/yote-conn"
CELL_RESTART='nohup /home/hatch/workspace/bin/squawk-tunnel-supervise.sh >/dev/null 2>&1 &'
CHECK_INTERVAL=30
FAIL_THRESHOLD=3

fails=0

while true; do
  if curl -s --max-time 10 "$HEALTH_URL" 2>/dev/null | grep -q '"cell_primary":true'; then
    fails=0
  else
    fails=$((fails + 1))
    if [ $fails -ge $FAIL_THRESHOLD ]; then
      logger -t tunnel-monitor "Tunnel down ${fails}x, restarting cell tunnel client"
      $YOTE_CONN exec "$CELL_RESTART" 2>/dev/null
      fails=0
      sleep 60
      continue
    fi
  fi
  sleep $CHECK_INTERVAL
done
