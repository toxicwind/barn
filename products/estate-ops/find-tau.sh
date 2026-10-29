#!/usr/bin/env bash
set -uo pipefail

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; N='\033[0m'
hdr() { echo -e "\n${C}=== $1 ===${N}"; }

hdr "1. Every path named 'tau*' under /home/toxic (depth 8, no node_modules)"
find /home/toxic -maxdepth 8 \
  \( -path '*/node_modules' -o -path '*/.git' -o -path '*/.next' -o -path '*/target' -o -path '*/dist' \) -prune -o \
  -iname 'tau*' -print 2>/dev/null | sort

hdr "2. Every 'omp' binary (executable) under /home/toxic"
find /home/toxic -maxdepth 10 -type f -name 'omp' -executable \
  -not -path '*/node_modules/*' 2>/dev/null -exec ls -la {} \;

hdr "3. Every 'launcher/tau' file"
find /home/toxic -maxdepth 12 -type f -path '*/launcher/tau' \
  -not -path '*/node_modules/*' 2>/dev/null -exec ls -la {} \;

hdr "4. Every 'coding-agent' package dir"
find /home/toxic -maxdepth 10 -type d -name 'coding-agent' \
  -not -path '*/node_modules/*' 2>/dev/null -exec ls -ld {} \;

hdr "5. Every package.json with name containing 'tau' or 'oh-my-pi'"
find /home/toxic -maxdepth 10 -name 'package.json' \
  -not -path '*/node_modules/*' -not -path '*/.next*' 2>/dev/null \
  -exec sh -c 'n=$(jq -r .name "$1" 2>/dev/null); case "$n" in *tau*|*oh-my-pi*|*@oh-my-pi*) echo "$1 :: $n";; esac' _ {} \; | head -40

hdr "6. Every git repo with remote containing 'tau' or 'oh-my-pi'"
find /home/toxic -maxdepth 6 -type d -name '.git' 2>/dev/null | while read -r g; do
  repo="$(dirname "$g")"
  url="$(git -C "$repo" remote get-url origin 2>/dev/null || true)"
  case "$url" in
    *tau*|*oh-my-pi*|*OhMyPi*) echo "$repo :: $url" ;;
  esac
done

hdr "7. Cargo.toml crates named pi-* or tau-*"
find /home/toxic -maxdepth 12 -name 'Cargo.toml' \
  -not -path '*/node_modules/*' -not -path '*/target/*' 2>/dev/null \
  -exec sh -c 'n=$(grep -m1 "^name" "$1" | cut -d\" -f2); case "$n" in pi-*|tau-*|omp-*) echo "$1 :: $n";; esac' _ {} \; | head -40

hdr "8. What bin/tau, bin/omp currently point at"
for f in /home/toxic/pens/barn/estate-ops/tau /home/toxic/pens/barn/estate-ops/omp; do
  if [ -L "$f" ]; then
    tgt="$(readlink -f "$f" 2>/dev/null || echo BROKEN)"
    [ -e "$tgt" ] && echo -e "  ${G}✓${N} $f -> $tgt" || echo -e "  ${Y}✗${N} $f -> $tgt (BROKEN)"
  elif [ -e "$f" ]; then
    echo "  $f exists (not a symlink)"
  fi
done

hdr "9. What's actually running as tau right now"
for pid in $(pgrep -f 'omp|chute|tau' 2>/dev/null); do
  cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 200)"
  case "$cmd" in *chute*|*acp*|*omp*|*tau*) echo "  pid $pid: $cmd" ;; esac
done | head -20

hdr "10. Pitchfork's tracked tau registration"
cd /home/toxic/estate 2>/dev/null && \
  pitchfork list --json 2>/dev/null | jq -r '.[] | select(.id|test("tau")) | "  \(.id) status=\(.status) pid=\(.pid) port=\(.port // "none")"' || \
  echo "  (pitchfork not responding)"

hdr "11. Git origin of the stockyard tau tree"
if [ -d /home/toxic/tau/.git ]; then
  cd /home/toxic/tau
  echo "  HEAD: $(git rev-parse --short HEAD 2>/dev/null)"
  echo "  origin: $(git remote get-url origin 2>/dev/null)"
  echo "  last commit: $(git log -1 --format='%s' 2>/dev/null)"
  echo "  branches:"
  git branch -a 2>/dev/null | head -10
else
  echo "  no .git at ranch/tau"
fi

hdr "12. What does omp --version say (the real one)"
OMP=/home/toxic/tau/packages/coding-agent/dist/tau
[ -x "$OMP" ] && "$OMP" --version 2>&1 | head -3 || echo "  not executable"

hdr "13. Top-level dirs of ranch/tau"
ls -la /home/toxic/tau 2>/dev/null | head -30

hdr "DONE"
