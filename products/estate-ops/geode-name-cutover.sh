#!/usr/bin/env bash
# geode naming-cutover sweep — pens/* wide (kappa 2026-10-27)
# Doctrine: estate AGENTS.md 2026-10-27 is the SSOT.
#   pinax        -> mimetite      (provider SSOT renamed)
#   hodos        -> rhodochrosite (gateway renamed; ranch/hodos holds proxy/)
#   chalcopyrite -> atlas         (merged provider gateway)
#   roost        -> mimetite      (roost->pinax Oct 19, pinax->mimetite latest)
#   omni         -> rhodochrosite (OmniRoute cutover chain ended at hodos)
#   super-ralph / shep / flock -> retired, refs get flagged not blind-renamed
# MODE=dry|apply
MODE="${1:-dry}"
EXCL=(-g '!.git' -g '!node_modules' -g '!bun.lock' -g '!*.lock' -g '!*.png' -g '!*.webp' -g '!*.jpg' -g '!*.ico' -g '!*.db' -g '!*.bin' -g '!*.wasm')
MAP=(
  -e 's/\bpinax\b/mimetite/g'
  -e 's/\bPinax\b/Mimetite/g'
  -e 's/\bPINAX\b/MIMETITE/g'
  -e 's/\bhodos\b/rhodochrosite/g'
  -e 's/\bHodos\b/Rhodochrosite/g'
  -e 's/\bHODOS\b/RHODOCHROSITE/g'
  -e 's/\bchalcopyrite\b/atlas/g'
  -e 's/\bChalcopyrite\b/Atlas/g'
  -e 's/\broost\b/mimetite/g'
  -e 's/\bRoost\b/Mimetite/g'
  -e 's/\bOmniRoute\b/rhodochrosite/g'
  -e 's/\bOmni\b/rhodochrosite/g'
)
for d in /home/toxic/pens/ranch /home/toxic/pens/barn /home/toxic/pens/olympus \
         /home/toxic/estate/agents /home/toxic/.openfang/agents /home/toxic/estate/agent-config \
         /home/toxic/estate/brain /home/toxic/estate/fleet; do
  echo "=== $d"
  # shellcheck disable=SC2046
  files=$(rg -l -i 'pinax|hodos|chalcopyrite|roost|OmniRoute' "${EXCL[@]}" "$d" 2>/dev/null)
  if [ -z "$files" ]; then echo "  clean"; continue; fi
  echo "$files" | while IFS= read -r f; do
    n=$(rg -c -i 'pinax|hodos|chalcopyrite|roost|OmniRoute' "$f" 2>/dev/null)
    echo "  $n  $f"
    if [ "$MODE" = apply ]; then
      perl -pi "${MAP[@]}" "$f"
    fi
  done
done