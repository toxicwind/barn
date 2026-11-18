#!/usr/bin/env bash
set +e
echo "== mcpproxy refs in pens code/config (excl vendor.old, node_modules, data dirs) =="
grep -rln "mcpproxy" /home/toxic/pens --include="*.md" --include="*.json" --include="*.toml" --include="*.yaml" --include="*.yml" --include="*.ts" --include="*.sh" --include="*.py" --include="*.go" 2>/dev/null \
  | grep -vE "vendor\.old|/vendor/|node_modules|_archaeology|/archive/|\.git/" | head -25
echo
echo "== which of those are PRODUCT docs (stale skill refs) =="
grep -rln "mcpproxy" /home/toxic/pens/geode/products/azurite/skills /home/toxic/pens/barn/products/Pens-ops 2>/dev/null | head -8