#!/usr/bin/env bash
# build.sh — vendored mcpproxy-go (thresher fork) build.
# Produces bin/thresher (the `serve` gateway binary) from the vendored
# mcpproxy-go source under ./vendor. No pinned fork binary: the estate
# gateway is built from the vendored source, forward-only.
set -euo pipefail
cd "$(dirname "$0")"

# Source is vendored from ranch/mcpproxy-go (module github.com/smart-mcp-proxy/mcpproxy-go).
VENDOR="${1:-vendor}"

# Ensure the //go:embed all:frontend/dist target exists (empty dir falls back
# to the embedded stub UI; real UI is built separately into web/frontend/dist).
mkdir -p "$VENDOR/web/frontend/dist"
touch "$VENDOR/web/frontend/dist/.gitkeep"

echo "building thresher from vendored mcpproxy-go..."
(cd "$VENDOR" && go build -o "$(readlink -f ..)/bin/thresher" ./cmd/mcpproxy)
echo "done: bin/thresher ($(du -h bin/thresher | cut -f1))"
bin/thresher --version