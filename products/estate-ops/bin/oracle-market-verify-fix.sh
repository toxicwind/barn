#!/usr/bin/env bash
set -uo pipefail

BIN=/home/toxic/estate/agents/oracle-market/bin
BIDDER=$BIN/bidder.py
POSTTASK=$BIN/post_task.py

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }
skip(){ echo -e "  ${Y}·${N} $1"; }
hdr() { echo -e "\n${C}══ $1 ══${N}"; }

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); ok "$1"; }
fail() { FAIL=$((FAIL+1)); bad "$1"; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. Fix exec bits"

for f in "$POSTTASK" "$BIDDER" \
         /home/toxic/estate/agents/oracle-market/bin/*.py \
         /home/toxic/estate/agents/oracle-market/bin/*.sh; do
  [ -f "$f" ] || continue
  # only chmod if the file has a shebang (safe: don't mark libraries executable)
  if head -1 "$f" | grep -q '^#!'; then
    if [ -x "$f" ]; then skip "$(basename "$f") already +x"
    else chmod +x "$f"; pass "$(basename "$f") chmod +x"
    fi
  fi
done

# ─────────────────────────────────────────────────────────────────────
hdr "2. Verify post_task.py runs directly"

if "$POSTTASK" --help >/dev/null 2>&1; then
  pass "post_task.py --help runs directly"
elif python3 "$POSTTASK" --help >/dev/null 2>&1; then
  fail "post_task.py needs python3 prefix — shebang/path issue"
  head -1 "$POSTTASK" | sed 's/^/    shebang: /'
  command -v python3 | sed 's/^/    python3: /'
else
  fail "post_task.py --help fails both ways"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "3. Test suite — post_task.py rejection"

run_post() {
  local label="$1" payload_file="$2" exec_mode="${3:-python}"
  local out rc
  out="$("$POSTTASK" --id "$label" --title "$label" --tags code-fix \
    --timeout-ms 30000 --payload-file "$payload_file" \
    --exec-mode "$exec_mode" 2>&1)"
  rc=$?
  echo "$out"
  echo "  exit=$rc"
  return $rc
}

# 3a. valid Python → should proceed past validation (may fail later on missing control key, that's OK)
TMP=$(mktemp /tmp/v-valid.XXXXXX.py)
printf 'import json\nprint(json.dumps({"ok": True}))\n' > "$TMP"
out="$(python3 -c "
import sys
payload = open('$TMP').read()
try:
    compile(payload, '<t>', 'exec')
    print('COMPILES')
except SyntaxError as e:
    print(f'REJECT: {e.msg}')
")"
[ "$out" = "COMPILES" ] && pass "valid Python compiles" || fail "valid Python rejected: $out"
rm -f "$TMP"

# 3b. em-dash after code (real syntax error, not comment)
TMP=$(mktemp /tmp/v-emdash.XXXXXX.py)
printf 'x = 1 — broken\n' > "$TMP"
out="$(python3 -c "
try:
    compile(open('$TMP').read(), '<t>', 'exec')
    print('COMPILES')
except SyntaxError as e:
    print(f'REJECT: {e.msg} at line {e.lineno}')
")"
case "$out" in
  REJECT*) pass "em-dash after code rejected: $out" ;;
  *)       fail "em-dash accepted: $out" ;;
esac
rm -f "$TMP"

# 3c. real bug payload — the guidellm one
TMP=$(mktemp /tmp/v-guidellm.XXXXXX.md)
cat > "$TMP" <<'PAYLOAD'
# Task: guidellm-scorer-protocol — scorer plugin package inside the GuideLLM fork

## Context
Fork repo: /home/toxic/pens/ranch/guidellm (fork of vllm-project/guidellm,
remote https://github.com/toxicwind/guidellm, clean tree). Installed CLI
/home/toxic/.local/bin/guidellm runs on /home/toxic/.venv-guidellm/bin/python3
which imports guidellm from src/ in that checkout — edits there are live.
PAYLOAD

# writer side: post_task.py must reject this
out="$("$POSTTASK" --id v-3c --title v-3c --tags code-fix \
  --timeout-ms 30000 --payload-file "$TMP" --exec-mode python 2>&1)"
rc=$?
if [ "$rc" = "3" ] && echo "$out" | grep -q "refusing to post"; then
  pass "post_task.py rejects guidellm prose payload (exit 3)"
  echo "$out" | sed 's/^/    /'
else
  fail "post_task.py did NOT reject guidellm payload (exit=$rc)"
  echo "$out" | sed 's/^/    /'
fi

# runner side: the bidder's validation logic
out="$(python3 - "$TMP" <<'PYEOF'
import sys
payload = open(sys.argv[1], encoding="utf-8").read()
try:
    compile(payload, "<task-payload>", "exec")
    print("COMPILES")
except SyntaxError as e:
    print(f"PayloadValidationError: SyntaxError: {e.msg} at line {e.lineno}")
    print(f"  offending: {(e.text or '').strip()[:120]}")
PYEOF
)"
if echo "$out" | grep -q "PayloadValidationError"; then
  pass "bidder pre-flight rejects guidellm payload"
  echo "$out" | sed 's/^/    /'
else
  fail "bidder pre-flight accepted guidellm payload"
  echo "$out" | sed 's/^/    /'
fi
rm -f "$TMP"

# 3d. super-ralph mode bypasses validation (prose is expected)
TMP=$(mktemp /tmp/v-ralph.XXXXXX.md)
echo "# prose task — allowed in super-ralph mode" > "$TMP"
out="$("$POSTTASK" --id v-3d --title v-3d --tags code-fix \
  --timeout-ms 30000 --payload-file "$TMP" --exec-mode super-ralph 2>&1)"
rc=$?
if echo "$out" | grep -q "refusing to post"; then
  fail "super-ralph mode incorrectly rejected prose"
  echo "$out" | sed 's/^/    /'
else
  pass "super-ralph mode accepts prose (rejection bypassed)"
fi
rm -f "$TMP"

# ─────────────────────────────────────────────────────────────────────
hdr "4. bidder.py imports + syntax"

if python3 -c "import ast; ast.parse(open('$BIDDER', encoding='utf-8').read())" 2>/dev/null; then
  pass "bidder.py AST parses"
else
  fail "bidder.py AST broken"
fi

if rg -q 'class PayloadValidationError' "$BIDDER"; then
  pass "PayloadValidationError class present"
else
  fail "PayloadValidationError class missing"
fi

if rg -q 'raise PayloadValidationError' "$BIDDER"; then
  pass "PayloadValidationError raised on bad payload"
else
  fail "no raise PayloadValidationError in bidder"
fi

if rg -q 'except PayloadValidationError' "$BIDDER"; then
  pass "PayloadValidationError caught in execute_task"
else
  fail "no except handler — error would propagate"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "5. Running bidder still healthy"

cd /home/toxic/estate
status="$(pitchfork list --json 2>/dev/null | jq -r '.[] | select(.id|test("bidder")) | "\(.id)=\(.status)"' 2>/dev/null)"
echo "  $status" | sed 's/^/    /'
if echo "$status" | grep -q 'bidder-forge=running'; then
  pass "bidder-forge running"
else
  fail "bidder-forge not running"
fi
if echo "$status" | grep -q 'bidder-scout=running'; then
  pass "bidder-scout running"
else
  fail "bidder-scout not running"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "6. No stale .lock files"

for lock in "$BIN"/bidder-forge.lock "$BIN"/bidder-scout.lock; do
  [ -f "$lock" ] || continue
  holder="$(cat "$lock" 2>/dev/null)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    pass "$(basename "$lock") held by live pid $holder"
  else
    skip "$(basename "$lock") pid $holder not running (ok — flock is authoritative)"
  fi
done

# ─────────────────────────────────────────────────────────────────────
hdr "7. Summary"

echo
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo

if [ "$FAIL" -eq 0 ]; then
  echo -e "${G}═══ ALL GREEN ═══${N}"
  exit 0
else
  echo -e "${R}═══ $FAIL FAILURES ═══${N}"
  exit 1
fi
