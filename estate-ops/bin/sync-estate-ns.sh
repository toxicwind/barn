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
CLONE="${ESTATE_ROOT:-/home/toxic/estate}"
PEN="${PENS_ESTATE:-/home/toxic/pens/estate}"

echo "sync-estate-ns: pitchfork.toml"
cp "$CLONE/pitchfork.toml" "$PEN/pitchfork.toml"

echo "sync-estate-ns: stack/ (mirror)"
ESTATE_ROOT="$CLONE" PENS_ESTATE="$PEN" bash /home/toxic/pens/barn/estate-ops/bin/sync-stack.sh

echo "sync-estate-ns: config/ports.env"
mkdir -p "$PEN/config"
cp "$CLONE/config/ports.env" "$PEN/config/ports.env"

echo "sync-estate-ns: qdrant-config.yaml"
cp "$CLONE/qdrant-config.yaml" "$PEN/qdrant-config.yaml"

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
