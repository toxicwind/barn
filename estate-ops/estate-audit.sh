#!/usr/bin/env bash
# sovereign-audit.sh — find bili, find the stale DAEMON_RUNTIME_DIR, audit both.
set -uo pipefail
SOV="${SOVEREIGN_HOME:-$HOME/estate}"
STALE="00a0a40d4f605f26"

sec() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
hit() { printf '  \033[1;32m+\033[0m %s\n' "$*"; }
warn(){ printf '  \033[1;33m!\033[0m %s\n' "$*"; }

sec "bili binary on PATH"
command -v bili && readlink -f "$(command -v bili)" || warn "bili not on PATH"

sec "bili under \$HOME (files + symlinks, no /proc)"
fd -H -t f -t l '^bili$' "$HOME" --max-depth 6 2>/dev/null | head -20

sec "billion-context package roots"
fd -H -t d 'billion-context' "$HOME" --max-depth 6 2>/dev/null | head -10

sec "bili inside sovereign tree"
fd -H -t f -t l 'bili' "$SOV" --max-depth 8 2>/dev/null | head -20

sec "bili source dirs under sovereign"
fd -H -t d 'bili' "$SOV" --max-depth 8 2>/dev/null | head -20

sec "sovereign/tools and sovereign/bin (bili often lives here)"
ls -la "$SOV/tools" 2>/dev/null | grep -i bili
ls -la "$SOV/bin"   2>/dev/null | grep -i bili

sec "scripts referencing bili inside sovereign"
rg -l --hidden -g '!.git' -g '!node_modules' '\bbili\b' "$SOV" 2>/dev/null | head -30

sec "stale hash occurrences (live files only, no backups)"
rg -l --hidden -g '!.git' -g '!node_modules' -g '!*bak*' -g '!*backup*' \
   -g '!*.live-*' -g '!*preserve*' "$STALE" "$HOME" 2>/dev/null | head -30

sec "wrapper line in ~/.local/bin/omp"
grep -n 'DAEMON_RUNTIME_DIR\|SOVEREIGN_HOME' "$HOME/.local/bin/omp" 2>/dev/null \
  || warn "no ~/.local/bin/omp"

sec "every live pitchfork.toml with DAEMON_RUNTIME_DIR"
fd -H -t f '^pitchfork\.toml$' "$HOME" --max-depth 6 2>/dev/null \
  | while read -r f; do
      grep -n 'DAEMON_RUNTIME_DIR' "$f" 2>/dev/null | sed "s|^|  $f: |"
    done

sec "live runtime dirs under .tau"
ls -1 "$HOME/.tau/run/daemons/" 2>/dev/null || warn "no .tau/run/daemons"

sec "live brokers"
ss -xlp 2>/dev/null | awk '/omp daemon brok|broker\.sock/ {print "  "$0}' | head

sec "running omp processes (count)"
printf '  count=%s\n' "$(pgrep -cf 'dist/omp' 2>/dev/null || echo 0)"

sec "done"
