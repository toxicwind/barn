#!/usr/bin/env bash
# keeper-floaty — supervised combined agent floaty (signalhead lamp + overlay).
# Part of the keeper/ego/browserless/signalhead combined stack: this daemon
# keeps the floaty always-on so the human is pinged (red) only when the agent
# needs them, yellow while working, green when idle. Files are shared via
# /home/toxic/.local/state/keeper-floaty as the signal bridge for agent hooks.
set -uo pipefail
SG=/home/toxic/pens/ranch/signalhead/src/cli.js
STATE=/home/toxic/.local/state/keeper-floaty
mkdir -p "$STATE"
exec /usr/bin/node "$SG" start --foreground --port 4747