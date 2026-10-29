#!/usr/bin/env bash
# sync-estate-ns.sh — sync EVERYTHING the live namespace needs from the
# estate clone (the tracked SSOT) into the pens namespace (what the
# supervisor actually loads). Run this after ANY commit to the estate clone
# that touches pitchfork.toml, config/ports.env, config/thresher/, or stack/.
#
# What it syncs:
#   pitchfork.toml        (the supervisor's monolith)
#   stack/                (lib-ports.sh + every service script)
#   config/thresher/mcp_config.json -> pens/ranch/thresher/ (thresher's REAL
#                           config path, gitignored by design)
# What it does NOT do: restart daemons (run pitchfork restart per-daemon).
set -euo pipefail
# 2026-10-28: /home/toxic/estate must NOT exist (single-truth lease). The
# default clone root is the pens SSOT itself; ESTATE_ROOT only overrides when
# a separate working clone is intentionally in play.
CLONE="${ESTATE_ROOT:-/home/toxic/pens/estate}"
PEN="${PENS_ESTATE:-/home/toxic/pens/estate}"

echo "sync-estate-ns: pitchfork.toml"
if [[ ! "$CLONE/pitchfork.toml" -ef "$PEN/pitchfork.toml" ]]; then
  cp "$CLONE/pitchfork.toml" "$PEN/pitchfork.toml"
fi

echo "sync-estate-ns: stack/ (mirror)"
ESTATE_ROOT="$CLONE" PENS_ESTATE="$PEN" bash /home/toxic/pens/barn/estate-ops/bin/sync-stack.sh

echo "sync-estate-ns: config/ports.env"
mkdir -p "$PEN/config"
if [[ ! "$CLONE/config/ports.env" -ef "$PEN/config/ports.env" ]]; then
  cp "$CLONE/config/ports.env" "$PEN/config/ports.env"
fi

echo "sync-estate-ns: qdrant-config.yaml"
if [[ ! "$CLONE/qdrant-config.yaml" -ef "$PEN/qdrant-config.yaml" ]]; then
  cp "$CLONE/qdrant-config.yaml" "$PEN/qdrant-config.yaml"
fi

if [[ -f "$CLONE/config/thresher/mcp_config.json" ]]; then
  echo "sync-estate-ns: thresher mcp_config -> pens/ranch/thresher/"
  mkdir -p /home/toxic/pens/ranch/thresher
  # Merge, don't clobber: the ranch file may have servers the clone lacks.
  python3 - "$CLONE/config/thresher/mcp_config.json" /home/toxic/pens/ranch/thresher/mcp_config.json <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
a = json.load(open(src)); b = json.load(open(dst))
names = {s["name"] for s in b["mcpServers"]}
added = 0
for s in a["mcpServers"]:
    if s["name"] not in names:
        b["mcpServers"].append(s); added += 1; names.add(s["name"])
json.dump(b, open(dst, "w"), indent=2)
print(f"  thresher merge: +{added} from clone, total {len(b['mcpServers'])}")
PY
fi

echo "sync-estate-ns: DONE (restart affected daemons to apply)"
