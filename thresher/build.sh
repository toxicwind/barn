#!/usr/bin/env bash
# build.sh — build the estate's own thresher gateway binary directly.
#
# Thresher IS the product: a fork of smart-mcp-proxy/mcpproxy-go with the
# estate's extensions (security leases, activity ledger, upstream ops, tray,
# TUI) living at the module root. The gateway is built from THIS tree
# (./cmd/mcpproxy), not from a vendored upstream clone.
set -euo pipefail
cd "$(dirname "$0")"

# The //go:embed all:frontend/dist target must exist (empty dir falls back to
# the embedded stub UI; the real UI is built separately into web/frontend/dist).
mkdir -p web/frontend/dist
touch web/frontend/dist/.gitkeep

echo "building thresher from the estate module root..."
go build -o "$(pwd)/bin/thresher" ./cmd/mcpproxy
echo "done: bin/thresher ($(du -h bin/thresher | cut -f1))"
bin/thresher --version