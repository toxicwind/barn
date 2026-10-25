#!/usr/bin/env bash
set -euo pipefail

BIN=/home/toxic/estate/bin
STOCK=/home/toxic/tau
PITCH=/home/toxic/estate/pitchfork.toml

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; N='\033[0m'
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
hdr()  { echo -e "\n${C}=== $1 ===${N}"; }

hdr "1. Fix bin/tau symlink"

if [ -f "$STOCK/launcher/tau" ]; then
  ln -sfn "$STOCK/launcher/tau" "$BIN/tau"
  ok "bin/tau -> $STOCK/launcher/tau"
else
  warn "no launcher/tau at $STOCK; leaving bin/tau alone"
fi

if [ -x "$STOCK/packages/coding-agent/dist/tau" ]; then
  ln -sfn "$STOCK/packages/coding-agent/dist/tau" "$BIN/omp"
  ok "bin/omp -> $STOCK/packages/coding-agent/dist/tau"
fi

hdr "2. Drop dangling tau-code from pitchfork groups"

python3 - "$PITCH" <<'PY'
import sys, re
p = sys.argv[1]
raw = open(p).read()
out = re.sub(r'("tau-code",\s*)', '', raw)
out = re.sub(r'(,\s*"tau-code")', '', out)
if out != raw:
    open(p, "w").write(out)
    print("  removed tau-code from group lists")
else:
    print("  no tau-code references found")
PY

grep -n 'tau-code' "$PITCH" || ok "no tau-code references remain"

hdr "3. Verify groups resolve"

cd /home/toxic/estate
pitchfork validate 2>&1 | tail -5 || warn "no validate subcommand"

hdr "DONE"
