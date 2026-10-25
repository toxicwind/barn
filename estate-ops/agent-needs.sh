#!/usr/bin/env bash
# agent-needs.sh — durable agent-needs-human GATE for the floaty stoplight.
#
# Any agent (kappa/tau/delendai swarm) calls this when it genuinely needs a
# human: OS term the floaty LED goes RED (needs-you), then yields the decision
# to the human. Exit code signals the need so the caller can gate on it.
#
#   agent-needs.sh "reason"   -> lamp waiting (red), exit 2
#   agent-needs.sh ok         -> lamp idle (green), exit 0
#   agent-needs.sh busy       -> lamp busy (yellow), exit 0
set -uo pipefail
SG=/home/toxic/pens/ranch/signalhead/src/cli.js
REASON="${1:-ok}"
case "$REASON" in
  ok|idle|done)
    /usr/bin/node "$SG" set idle --agent desk >/dev/null 2>&1
    curl -s --max-time 4 http://127.0.0.1:4747/state 2>/dev/null | head -c 60; echo
    exit 0
    ;;
  busy|working)
    /usr/bin/node "$SG" set busy --agent desk >/dev/null 2>&1
    curl -s --max-time 4 http://127.0.0.1:4747/state 2>/dev/null | head -c 60; echo
    exit 0
    ;;
  *)
    # needs human: red floaty + non-zero exit so the caller gates on it
    /usr/bin/node "$SG" set waiting --agent desk "$REASON" >/dev/null 2>&1
    printf 'NEEDS-HUMAN: %s\n' "$REASON"
    curl -s --max-time 4 http://127.0.0.1:4747/state 2>/dev/null | head -c 60; echo
    exit 2
    ;;
esac