#!/usr/bin/env bash
set -euo pipefail

STOCK=/home/toxic/tau
OLD=/home/toxic/tau
EDGE=/home/toxic/edge-work/estate-projects/projects/tau
ORACLE=/home/toxic/oracle-hardening-wt/projects/tau
BIN=/home/toxic/estate/bin

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1"; }
hdr()  { echo -e "\n${C}=== $1 ===${N}"; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. What does the surviving launcher actually do?"

SRC=""
for c in "$EDGE/launcher/tau" "$ORACLE/launcher/tau"; do
  [ -f "$c" ] && SRC="$c" && break
done

if [ -z "$SRC" ]; then
  err "no launcher/tau found in worktrees"
  exit 1
fi
ok "source: $SRC"
echo
echo "  --- full contents ---"
cat -n "$SRC"
echo "  --------------------"

# ─────────────────────────────────────────────────────────────────────
hdr "2. Does ranch/tau already have launcher/ or dist/tau?"

if [ -d "$STOCK/launcher" ]; then
  ok "stockyard has launcher/ — contents:"
  ls -la "$STOCK/launcher/"
else
  warn "stockyard has no launcher/"
fi

if [ -f "$STOCK/packages/coding-agent/dist/tau" ]; then
  ok "stockyard has dist/tau binary:"
  ls -la "$STOCK/packages/coding-agent/dist/tau"
else
  warn "stockyard has NO dist/tau binary"
fi

echo
echo "  old tree check — is projects/tau still there?"
if [ -d "$OLD" ]; then
  ok "projects/tau EXISTS"
  ls -la "$OLD/launcher/tau" 2>/dev/null || warn "no launcher/tau in old tree"
  ls -la "$OLD/packages/coding-agent/dist/tau" 2>/dev/null || warn "no dist/tau in old tree"
else
  warn "projects/tau is gone"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "3. Install launcher into ranch/tau"

mkdir -p "$STOCK/launcher"
cp "$SRC" "$STOCK/launcher/tau"
chmod +x "$STOCK/launcher/tau"
ok "installed $STOCK/launcher/tau"

# ─────────────────────────────────────────────────────────────────────
hdr "4. Fix bin/tau symlink"

if [ -f "$STOCK/launcher/tau" ]; then
  ln -sfn "$STOCK/launcher/tau" "$BIN/tau"
  ok "bin/tau -> $STOCK/launcher/tau"
elif [ -x "$STOCK/packages/coding-agent/dist/tau" ]; then
  ln -sfn "$STOCK/packages/coding-agent/dist/tau" "$BIN/tau"
  warn "no launcher; fell back to bin/tau -> dist/tau"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "5. Does bin/tau actually run?"

export OMP_ROOT="$STOCK"
if "$BIN/tau" --version 2>&1 | head -5; then
  ok "bin/tau works"
else
  err "bin/tau failed — inspect launcher source above"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "6. Old processes from projects/tau — still live?"

for pid in $(pgrep -f 'projects/tau/' 2>/dev/null); do
  cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 200)"
  warn "pid $pid from old tree: $cmd"
done
echo "  (these will keep running until restarted; not blocking)"

# ─────────────────────────────────────────────────────────────────────
hdr "DONE"
echo "  launcher : $STOCK/launcher/tau"
echo "  symlink  : $BIN/tau"
echo "  binary   : $STOCK/packages/coding-agent/dist/tau"
