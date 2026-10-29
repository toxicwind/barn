#!/usr/bin/env bash
set -euo pipefail

BIN=/home/toxic/estate/agents/oracle-market/bin
BIDDER=$BIN/bidder.py
POSTTASK=$BIN/post_task.py

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "  ${G}✓${N} $1"; }
bad() { echo -e "  ${R}✗${N} $1"; }
skip(){ echo -e "  ${Y}·${N} $1"; }
hdr() { echo -e "\n${C}══ $1 ══${N}"; }

TS=$(date +%s)

hdr "1. Backups"

cp "$BIDDER" "$BIDDER.bak.$TS"
cp "$POSTTASK" "$POSTTASK.bak.$TS"
ok "bidder.py.bak.$TS"
ok "post_task.py.bak.$TS"

# ─────────────────────────────────────────────────────────────────────
hdr "2. Patch bidder.py"

if rg -q 'PayloadValidationError' "$BIDDER"; then
  skip "already patched"
else
  python3 - "$BIDDER" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()

# --- 2a. class PayloadValidationError near the top ---
anchor = "CHANNEL = ol.CHANNEL\n"
if anchor not in src:
    sys.exit("anchor 1 not found: CHANNEL = ol.CHANNEL")
insertion = (
    "CHANNEL = ol.CHANNEL\n"
    "\n"
    "\n"
    "class PayloadValidationError(Exception):\n"
    "    \"\"\"Raised when a task payload fails pre-flight compilation.\n"
    "\n"
    "    A markdown payload (prose, em-dashes, curly quotes) that slipped\n"
    "    past the writer would otherwise die with a SyntaxError deep in\n"
    "    the subprocess and burn the oracle's exec deadline. Failing fast\n"
    "    here records a clean rejection instead of a subprocess error.\n"
    "    \"\"\"\n"
    "    pass\n"
    "\n"
)
src = src.replace(anchor, insertion, 1)

# --- 2b. compile check before python3 -c ---
old_else = '''            else:
                base_cmd = ["python3", "-c", payload]'''
new_else = '''            else:
                # Pre-flight validation: payloads destined for
                # `python3 -c` must compile. Fail fast with the compiler
                # diagnostic instead of a SyntaxError inside the subprocess.
                try:
                    compile(payload, "<task-payload>", "exec")
                except SyntaxError as e:
                    raise PayloadValidationError(
                        "payload rejected before execution: "
                        "SyntaxError: %s at line %s: %s"
                        % (e.msg, e.lineno, (e.text or "").strip()[:120])
                    ) from e
                base_cmd = ["python3", "-c", payload]'''
if old_else not in src:
    sys.exit("anchor 2 not found: else: base_cmd = [python3, -c, payload]")
src = src.replace(old_else, new_else, 1)

# --- 2c. except handler for PayloadValidationError, before Exception ---
old_except = '''        except subprocess.TimeoutExpired:
            dur = (time.time() - t0) * 1000
            err = f"timeout after {min(timeout_ms/1000.0, PAYLOAD_CAP_S):.0f}s"'''
new_except = '''        except PayloadValidationError as e:
            dur = (time.time() - t0) * 1000
            success, out = False, ""
            err = str(e)
        except subprocess.TimeoutExpired:
            dur = (time.time() - t0) * 1000
            err = f"timeout after {min(timeout_ms/1000.0, PAYLOAD_CAP_S):.0f}s"'''
if old_except not in src:
    sys.exit("anchor 3 not found: except subprocess.TimeoutExpired in execute_task")
src = src.replace(old_except, new_except, 1)

open(path, "w", encoding="utf-8").write(src)
print("    patched bidder.py")
PYEOF

  if python3 -c "import ast,sys; ast.parse(open('$BIDDER',encoding='utf-8').read())" 2>/dev/null; then
    ok "bidder.py syntax valid"
  else
    bad "bidder.py syntax broken — restoring"
    cp "$BIDDER.bak.$TS" "$BIDDER"
    exit 1
  fi
fi

# ─────────────────────────────────────────────────────────────────────
hdr "3. Patch post_task.py"

if rg -q 'refusing to post' "$POSTTASK"; then
  skip "already patched"
else
  python3 - "$POSTTASK" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()

anchor = '    payload = Path(args.payload_file).read_text(encoding="utf-8")\n'
if anchor not in src:
    sys.exit("anchor not found: payload = Path(args.payload_file).read_text")
insertion = (
    '    payload = Path(args.payload_file).read_text(encoding="utf-8")\n'
    '\n'
    '    # Pre-flight validation: a payload destined for `python3 -c`\n'
    '    # must compile. Refuse to post invalid payloads with the\n'
    '    # compiler\'s own diagnostic. Use --exec-mode super-ralph for\n'
    '    # prose prompts (those bypass the check by design).\n'
    '    if args.exec_mode == "python":\n'
    '        try:\n'
    '            compile(payload, "<task-payload>", "exec")\n'
    '        except SyntaxError as e:\n'
    '            sys.stderr.write(\n'
    '                "post_task: refusing to post %r: payload is not valid "\n'
    '                "Python (exec_mode=%s):\\n"\n'
    '                "  %s at line %s\\n"\n'
    '                "  %s\\n"\n'
    '                "Fix the payload, or pass --exec-mode super-ralph "\n'
    '                "for prose prompts.\\n"\n'
    '                % (args.id, args.exec_mode, e.msg, e.lineno,\n'
    '                   (e.text or "").strip())\n'
    '            )\n'
    '            sys.exit(3)\n'
    '\n'
)
src = src.replace(anchor, insertion, 1)
open(path, "w", encoding="utf-8").write(src)
print("    patched post_task.py")
PYEOF

  if python3 -c "import ast,sys; ast.parse(open('$POSTTASK',encoding='utf-8').read())" 2>/dev/null; then
    ok "post_task.py syntax valid"
  else
    bad "post_task.py syntax broken — restoring"
    cp "$POSTTASK.bak.$TS" "$POSTTASK"
    exit 1
  fi
fi

# ─────────────────────────────────────────────────────────────────────
hdr "4. Test: valid Python compiles"

TMP=$(mktemp /tmp/valid.XXXXXX.py)
printf 'import json\nprint(json.dumps({"ok": True, "n": 42}))\n' > "$TMP"
if python3 -c "compile(open('$TMP').read(), '<t>', 'exec')" 2>/dev/null; then
  ok "valid Python payload compiles"
else
  bad "valid payload rejected — bug"
fi
rm -f "$TMP"

hdr "5. Test: em-dash markdown rejected"

TMP=$(mktemp /tmp/bad.XXXXXX.md)
printf '# Task: guidellm-scorer-protocol \xe2\x80\x94 scorer plugin package\n\n## Context\nFork repo: /home/toxic/pens/ranch/guidellm\n' > "$TMP"
if python3 - "$TMP" <<'PYEOF'
import sys
payload = open(sys.argv[1], encoding="utf-8").read()
try:
    compile(payload, "<t>", "exec")
    sys.exit(1)  # unexpected success
except SyntaxError:
    sys.exit(0)
PYEOF
then
  ok "em-dash markdown rejected by compile()"
else
  bad "compile accepted it — unexpected"
fi
rm -f "$TMP"

hdr "6. Test: post_task.py rejects em-dash with clear error"

TMP=$(mktemp /tmp/bad.XXXXXX.py)
printf '# Task: fix the thing \xe2\x80\x94 now\n' > "$TMP"
RESULT=$(python3 -c '
import sys
payload = open(sys.argv[1], encoding="utf-8").read()
try:
    compile(payload, "<t>", "exec")
    print("PASS")
except SyntaxError as e:
    print(f"REJECT {e.msg} at line {e.lineno}")
' "$TMP")
echo "  $RESULT"
case "$RESULT" in
  REJECT*) ok "rejection fires cleanly" ;;
  *)       bad "rejection did not fire" ;;
esac
rm -f "$TMP"

# ─────────────────────────────────────────────────────────────────────
hdr "7. Diff"

echo "  ── bidder.py ──"
diff "$BIDDER.bak.$TS" "$BIDDER" || true
echo
echo "  ── post_task.py ──"
diff "$POSTTASK.bak.$TS" "$POSTTASK" || true

# ─────────────────────────────────────────────────────────────────────
hdr "8. Restart bidders"

cd /home/toxic/estate
for d in estate/bidder-forge estate/bidder-scout; do
  if pitchfork list --json 2>/dev/null | jq -e ".[] | select(.id==\"$d\")" >/dev/null; then
    pitchfork restart "$d" 2>&1 | tail -2 | sed 's/^/    /' || true
    ok "$d restarted"
  else
    skip "$d not registered"
  fi
done

hdr "DONE"
echo "  bidder.py   : $BIDDER   (bak: $BIDDER.bak.$TS)"
echo "  post_task.py: $POSTTASK (bak: $POSTTASK.bak.$TS)"
