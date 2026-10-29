#!/usr/bin/env bash
set -uo pipefail
OUT=/home/toxic/estate/bin/model-audit-max.out
mkdir -p "$OUT"
CATALOG="$OUT/catalog.jsonl"; PROBES="$OUT/probes.jsonl"; WORKING="$OUT/working.jsonl"
: > "$CATALOG"; : > "$PROBES"

NIM_KEY="$(grep -E '^NVIDIA_API_KEY=' /home/toxic/.9router/env.systemd 2>/dev/null | cut -d= -f2-)"
FLOCK_KEY="$(cat /home/toxic/.tau/flock.key 2>/dev/null || echo '')"
VR_KEY="$(grep -E '^API_KEY_SECRET=' /home/toxic/.config/vansrouter/env 2>/dev/null | cut -d= -f2- || echo '')"

# 1. catalog - every /v1/models with metadata
fetch_catalog() { local prov="$1" url="$2" auth="$3"; local hdrs=(); [ -n "$auth" ] && hdrs=(-H "Authorization: Bearer $auth"); curl -s "${hdrs[@]}" "$url/models" --max-time 10 2>/dev/null | jq -c --arg p "$prov" '(.data//.)[] | {provider:$p,id:.id,owned_by:(.owned_by//""),ctx:(.context_length//.context_window//0)}' 2>/dev/null >> "$CATALOG" || true; }
fetch_catalog nim "https://integrate.api.nvidia.com/v1" "$NIM_KEY"
fetch_catalog herd "http://127.0.0.1:25100/v1" ""
fetch_catalog sov "http://127.0.0.1:25104/v1" ""
fetch_catalog flock "http://127.0.0.1:25193/v1" "$FLOCK_KEY"
fetch_catalog vr "http://127.0.0.1:25237/v1" "$VR_KEY"

# 2. probe - NO arithmetic on model name, fully quoted
cat > /tmp/probe.sh <<'PROBE'
#!/usr/bin/env bash
prov="$1"; model="$2"; url="$3"; auth="$4"
hdrs=(-H 'Content-Type: application/json')
[ -n "$auth" ] && hdrs+=(-H "Authorization: Bearer $auth")
t0=$(date +%s%3N)
body=$(curl -s -w '__CODE__%{http_code}' -X POST "$url/chat/completions" "${hdrs[@]}" -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"pong\"}],\"max_tokens\":4}" --max-time 8 2>&1)
code=$(echo "$body" | sed -n 's/.*__CODE__\([0-9]*\)$/\1/p'); raw=$(echo "$body" | sed 's/__CODE__[0-9]*$//')
t1=$(date +%s%3N); wall=$((t1-t0))
content=""; detail=""; status="unknown"
if echo "$raw" | jq -e. >/dev/null 2>&1; then
  content=$(echo "$raw" | jq -r '.choices[0].message.content//empty' 2>/dev/null | tr -d '\n' | head -c 100)
  detail=$(echo "$raw" | jq -r '.error.message//.error.detail//.detail//empty' 2>/dev/null | head -c 200)
fi
case "$code" in 200) [ -n "$content" ] && status="ok_with_content" || status="ok_empty" ;; 401) status="unauthorized" ;; 403) status="forbidden" ;; 404) status="not_found" ;; 410) status="gone_eol" ;; 429) status="rate_limited" ;; 500) status="500" ;; 502) status="bad_gateway" ;; 503) status="unavailable" ;; "") status="timeout" ;; *) status="http_$code" ;; esac
jq -nc --arg p "$prov" --arg m "$model" --arg c "$code" --arg s "$status" --argjson w "$wall" --arg ct "$content" --arg d "$detail" '{provider:$p,model:$m,code:$c,status:$s,wall_ms:$w,preview:$ct,error:$d}'
PROBE
chmod +x /tmp/probe.sh

# parallel WITHOUT ever using $model in arithmetic
jq -r '[.provider,.id] | @tsv' "$CATALOG" | xargs -P 24 -I{} bash -c '
  IFS=$'"'"'\t'"'"' read -r prov model <<< "{}"
  case "$prov" in nim) url="https://integrate.api.nvidia.com/v1"; auth="'"$NIM_KEY"'";; herd) url="http://127.0.0.1:25100/v1"; auth="";; sov) url="http://127.0.0.1:25104/v1"; auth="";; flock) url="http://127.0.0.1:25193/v1"; auth="'"$FLOCK_KEY"'";; vr) url="http://127.0.0.1:25237/v1"; auth="'"$VR_KEY"'";; esac
  /tmp/probe.sh "$prov" "$model" "$url" "$auth"
' >> "$PROBES"

# 3. taxonomy matrix - not reachable binary
echo "══ taxonomy status x provider ══"
printf '%-20s %5s %5s %5s %5s %5s\n' STATUS nim herd sov flock vr
for s in $(jq -r.status "$PROBES" | sort -u); do
  printf '%-20s' "$s"
  for p in nim herd sov flock vr; do n=$(jq -r --arg s "$s" --arg p "$p" 'select(.status==$s and.provider==$p)|.model' "$PROBES" | wc -l); printf ' %5d' "$n"; done; echo
done

jq -c 'select(.status=="ok_with_content")' "$PROBES" > "$WORKING"
echo "working: $(wc -l < "$WORKING") / total $(wc -l < "$PROBES")"

# 4. guidellm maximal - use its real profiles【841304591225841903†L18-L22】 sweep, synchronous, concurrent, throughput, constant
cat > /tmp/run_g.sh <<'RG'
#!/usr/bin/env bash
prov="$1"; model="$2"; url="$3"; auth="$4"
# guidellm run --profile kind=synchronous = sequential【841304591225841903†L28-L32】
# --profile kind=concurrent,streams=4 = parallel users
# --profile kind=sweep,rate=10 = 10 strategies including sync+throughput【3448752909002851569†L3-L10】
guidellm run --backend kind=openai_http,target="$url",model="$model" --data 'prompt="pong",prompt_tokens=10,output_tokens=20' --profile kind=synchronous --constraint kind=max_requests,count=5 --output kind=json,path=/tmp/${prov}_${model//\//_}_sync.json 2>&1 | tail -5
RG
chmod +x /tmp/run_g.sh
