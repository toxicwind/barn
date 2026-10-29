#!/usr/bin/env bash
# model-audit.sh — sweep every provider, benchmark reachable models, rank.
# Read-only. Writes results to /home/toxic/pens/barn/estate-ops/model-audit.out/

set -euo pipefail

OUT=/home/toxic/pens/barn/estate-ops/model-audit.out
mkdir -p "$OUT"

BEARER="$(grep -E '^API_KEY_SECRET=' /home/toxic/.config/vansrouter/env | cut -d= -f2-)"
FLOCK_KEY="$(cat /home/toxic/.tau/flock.key 2>/dev/null || echo '')"

# provider:name:port:auth
PROVIDERS=(
  "herd:http://127.0.0.1:25100/v1::"
  "sov-router:http://127.0.0.1:25104/v1::"
  "flock:http://127.0.0.1:25193/v1:$FLOCK_KEY:bearer"
  "vansrouter:http://127.0.0.1:20128/v1:$BEARER:bearer"
)

# Audit battery — each prompt has a check function
# Format: id|prompt|expected_substring|weight
BATTERY=(
  "arithmetic|What is 47*89? Answer with just the number.|4183|2"
  "json|Output exactly this JSON and nothing else: {\"status\":\"ok\",\"n\":42}|status|2"
  "instruction|Reply with exactly the word BANANA and nothing else.|BANANA|3"
  "reasoning|If all bloops are razzies and all razzies are lazzies, are all bloops lazzies? Answer yes or no.|yes|2"
  "code|Write a Python one-liner that reverses the string 'hello'. Output only the code.|::-1|2"
  "multilingual|Translate 'hello' to Spanish. Reply with one word.|hola|1"
)

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }
hdr() { echo -e "\n${C}══ $1 ══${N}"; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. Discover models per provider"

declare -A MODEL_LIST  # provider -> newline-separated model ids

for entry in "${PROVIDERS[@]}"; do
  IFS=':' read -r name base auth mode <<< "$entry"
  # handle http:// containing colons
  name="${entry%%:*}"
  rest="${entry#*:}"
  base="${rest%%:*}"
  auth="${rest##*:}"
  [ "$auth" = "$base" ] && auth=""

  hdrs=(-H 'Content-Type: application/json')
  [ -n "$auth" ] && hdrs+=(-H "Authorization: Bearer $auth")

  resp="$(curl -s "${hdrs[@]}" "$base/models" --max-time 10 2>/dev/null || echo '')"
  models="$(echo "$resp" | jq -r '(.data // .)[]?.id' 2>/dev/null || echo '')"

  if [ -z "$models" ]; then
    bad "$name: no models"
    MODEL_LIST[$name]=""
  else
    count="$(echo "$models" | wc -l)"
    ok "$name: $count models"
    echo "$models" > "$OUT/models-$name.txt"
    MODEL_LIST[$name]="$models"
  fi
done

# ─────────────────────────────────────────────────────────────────────
hdr "2. Reachability sweep (5 models/provider)"

REACH="$OUT/reachability.tsv"
: > "$REACH"
printf '%-14s\t%-50s\t%-6s\t%-8s\n' "provider" "model" "code" "ms" >> "$REACH"

for entry in "${PROVIDERS[@]}"; do
  name="${entry%%:*}"
  rest="${entry#*:}"
  base="${rest%%:*}"
  auth="${rest##*:}"
  [ "$auth" = "$base" ] && auth=""

  mapfile -t models < <(echo "${MODEL_LIST[$name]}" | head -5)
  for model in "${models[@]}"; do
    [ -z "$model" ] && continue
    hdrs=(-H 'Content-Type: application/json')
    [ -n "$auth" ] && hdrs+=(-H "Authorization: Bearer $auth")

    t0="$(date +%s%3N)"
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/chat/completions" \
      "${hdrs[@]}" \
      -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":3,\"stream\":false}" \
      --max-time 30 2>/dev/null || echo ERR)"
    t1="$(date +%s%3N)"
    ms=$(( t1 - t0 ))

    printf '%-14s\t%-50s\t%-6s\t%-8s\n' "$name" "$model" "$code" "$ms" >> "$REACH"

    case "$code" in
      200) printf '  %s %-14s %-50s %sms\n' "${G}✓${N}" "$name" "$model" "$ms" ;;
      404) printf '  %s %-14s %-50s %s (no perm)\n' "${R}✗${N}" "$name" "$model" "$code" ;;
      *)   printf '  %s %-14s %-50s %s\n' "${Y}?${N}" "$name" "$model" "$code" ;;
    esac
  done
done

# ─────────────────────────────────────────────────────────────────────
hdr "3. Correctness battery (reachable models only)"

SCORES="$OUT/scores.tsv"
: > "$SCORES"
printf '%-14s\t%-50s\t%-6s\t%-6s\t%-8s\t%s\n' "provider" "model" "score" "pass" "total_ms" "fails" >> "$SCORES"

# for each provider, test top-3 reachable models
for entry in "${PROVIDERS[@]}"; do
  name="${entry%%:*}"
  rest="${entry#*:}"
  base="${rest%%:*}"
  auth="${rest##*:}"
  [ "$auth" = "$base" ] && auth=""

  mapfile -t models < <(echo "${MODEL_LIST[$name]}" | head -3)
  for model in "${models[@]}"; do
    [ -z "$model" ] && continue

    score=0; pass=0; total_ms=0; fails=""

    for task in "${BATTERY[@]}"; do
      IFS='|' read -r tid prompt expected weight <<< "$task"

      hdrs=(-H 'Content-Type: application/json')
      [ -n "$auth" ] && hdrs+=(-H "Authorization: Bearer $auth")

      t0="$(date +%s%3N)"
      resp="$(curl -s -X POST "$base/chat/completions" "${hdrs[@]}" \
        -d "$(jq -nc --arg m "$model" --arg p "$prompt" \
              '{model:$m, messages:[{role:"user",content:$p}], max_tokens:64, stream:false}')" \
        --max-time 45 2>/dev/null || echo '')"
      t1="$(date +%s%3N)"
      total_ms=$(( total_ms + t1 - t0 ))

      text="$(echo "$resp" | jq -r '.choices[0].message.content // empty' 2>/dev/null | tr -d '\n')"
      if echo "$text" | grep -qiF "$expected"; then
        pass=$(( pass + 1 ))
        score=$(( score + weight ))
      else
        fails="${fails},${tid}"
      fi
    done

    printf '%-14s\t%-50s\t%-6s\t%-6s\t%-8s\t%s\n' "$name" "$model" "$score" "$pass" "$total_ms" "${fails#,}" >> "$SCORES"
    printf '  %-14s %-45s score=%-3s pass=%s/6  total=%sms  fails=%s\n' \
      "$name" "$model" "$score" "$pass" "$total_ms" "${fails#,}"
  done
done

# ─────────────────────────────────────────────────────────────────────
hdr "4. Ranking"

echo
echo "  by score (desc), then latency (asc):"
echo
{
  echo "PROVIDER|MODEL|SCORE|PASS|TOTAL_MS|FAILS"
  tail -n +2 "$SCORES"
} | awk -F'\t' 'NR>1 {print $1"|"$2"|"$3"|"$4"|"$5"|"$6}' | \
  sort -t'|' -k3,3nr -k5,5n | head -20 | \
  awk -F'|' '{printf "  %-14s %-45s score=%-3s pass=%s/6  %sms  fails=%s\n", $1,$2,$3,$4,$5,$6}'

# ─────────────────────────────────────────────────────────────────────
hdr "5. Summary by provider"

echo
for entry in "${PROVIDERS[@]}"; do
  name="${entry%%:*}"
  reach_200="$(grep -c "^$name" "$REACH" 2>/dev/null || echo 0)"
  reach_ok="$(awk -F'\t' -v n="$name" '$1==n && $3=="200"' "$REACH" 2>/dev/null | wc -l)"
  echo "  $name: $reach_ok/$(echo "${MODEL_LIST[$name]}" | grep -c .) top-5 reachable"
done

echo
echo "  artifacts:"
echo "    $OUT/reachability.tsv  — per-model latency + code"
echo "    $OUT/scores.tsv        — per-model correctness score"
echo "    $OUT/models-*.txt      — full model list per provider"
echo
hdr "DONE"
