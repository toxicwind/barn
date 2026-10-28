#!/usr/bin/env bash
# agentsmd_preprobe — sweep what .md walls kappa injects into every agent session.
# Sweep, not handshake: no LLM calls, no network. Inventory → JSON.
set -uo pipefail
ROOT="${ROOT:-/tmp/kappa/agentsmd-audit}"
OUT="$ROOT/preprobe.json"; TMP="$ROOT/preprobe.tmp.json"; : > "$TMP"
jadd() { jq -cn --arg k "$1" --arg p "$2" --arg d "$3" --arg x "$4" \
  '{kind:$k,path:$p,detail:$d,extra:$x}' >> "$TMP"; }

# 1. candidate .md injection surfaces on disk
for f in /home/toxic/AGENTS.md /home/toxic/estate/AGENTS.md \
         /home/toxic/.config/kappa/AGENTS.md /home/toxic/.config/kappa/kappa/AGENTS.md \
         /home/toxic/.kappa/AGENTS.md /home/toxic/kappa/AGENTS.md; do
  [[ -f "$f" ]] && jadd "md" "$f" "$(wc -c <"$f") bytes" "$(wc -l <"$f") lines"
done
# nested AGENTS.md trees (first 2 levels under active dirs)
while read -r f; do
  jadd "md-nested" "$f" "$(wc -c <"$f") bytes" ""
done < <(find /home/toxic/pens /home/toxic/estate /home/toxic/sovereign -maxdepth 3 -name AGENTS.md 2>/dev/null | head -100)

# 2. kappa.jsonc instructions config
K="$HOME/.config/kappa/kappa.jsonc"
[[ -f "$K" ]] && jadd "cfg-instructions" "$K" \
  "$(jq -r '.instructions // "ABSENT"' "$K" 2>/dev/null | head -c 300)" ""

# 3. kappa-code source: hardcoded default prompts / AGENTS.md defaults
KC=/home/toxic/pens/olympus/products/kappa/kappa-code
[[ -d "$KC" ]] && grep -rln "AGENTS.md" "$KC/packages" --include="*.ts" 2>/dev/null \
  | grep -v node_modules | grep -v test | while read -r f; do
    jadd "src-ref" "$f" "$(grep -c "AGENTS.md" "$f") refs" ""
  done
# default instruction constants
[[ -d "$KC" ]] && grep -rn "default.*instruction\|DEFAULT_INSTRUCTION\|built-in prompt\|systemPrompt.*default" \
  "$KC/packages/coding-agent/src" --include="*.ts" 2>/dev/null | head -20 \
  | while IFS=: read -r f l rest; do jadd "src-default" "$f" "L$l" "$rest"; done

# 4. what the CURRENT session actually carries (system-prompt evidence)
[[ -f /home/toxic/AGENTS.md ]] && jadd "live-inject" "/home/toxic/AGENTS.md" \
  "$(wc -c </home/toxic/AGENTS.md) bytes ≈ $(( $(wc -c </home/toxic/AGENTS.md) / 4 )) tokens" "mirrors estate AGENTS.md per its header"
[[ -f /home/toxic/estate/AGENTS.md ]] && jadd "live-inject" "/home/toxic/estate/AGENTS.md" \
  "$(wc -c </home/toxic/estate/AGENTS.md) bytes ≈ $(( $(wc -c </home/toxic/estate/AGENTS.md) / 4 )) tokens" ""

# 5. duplication check: identical files?
A=/home/toxic/AGENTS.md; B=/home/toxic/estate/AGENTS.md; C=$HOME/.config/kappa/AGENTS.md
[[ -f $A && -f $B ]] && jadd "dup-check" "$A vs $B" \
  "$( [[ $(md5sum <"$A") == $(md5sum <"$B") ]] && echo IDENTICAL || echo DIFFER )" ""
[[ -f $A && -f $C ]] && jadd "dup-check" "$A vs $C" \
  "$( [[ $(md5sum <"$A") == $(md5sum <"$C") ]] && echo IDENTICAL || echo DIFFER )" ""

jq -s '.' "$TMP" > "$OUT"; rm -f "$TMP"
echo "══ agentsmd preprobe ══"
jq -r 'group_by(.kind)[] | "\(.[0].kind) (\(length))", (.[] | "  - \(.path)  \(.detail)")' "$OUT"
echo "wrote $OUT"
