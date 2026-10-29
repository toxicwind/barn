#!/usr/bin/env bash
# stall-detect.sh — diagnose-only stall/idle detector for the agent fleet.
#
# HARD RULE: this script NEVER kills, stops, closes, or restarts anything.
# It reports evidence + safe resume paths only. There is no kill code in it.
#
# Two-phase operation (the agent DB is reachable ONLY through the muse.db tool,
# not from a shell, so an agent with muse.db access runs both phases):
#
#   Phase 1:  ./stall-detect.sh
#             - runs all shell-reachable checks (yote live state, oracle market,
#               ledgers, locks, local procs)
#             - writes /tmp/stall-detect-phase1.json
#             - writes /tmp/stall-detect.sql with the exact bounded queries to
#               run through muse.db (4 queries; all row/byte/time bounded)
#
#   Phase 2:  run the queries from /tmp/stall-detect.sql via muse.db, save the
#             JSON results as {"q1":[...],"q2":[...],"q3":[...],"q4":[...],
#             "q5":[...],"q6":[...],"q7":[...]} then:
#             ./stall-detect.sh --merge db-results.json
#             - combines DB evidence + phase-1 data, prints per-task verdicts:
#               ACTIVE / IDLE-DONE (cosmetic) / STALLED / ERRORED-SPAWN + the
#               SAFE resume path for each.
#
# Exit codes: 0 = report produced (even if stalls found — finding them is the job),
#             2 = usage/environment error.
set -u

YOTE_CONN="${YOTE_CONN:-$HOME/workspace/bin/yote-conn}"
PHASE1=/tmp/stall-detect-phase1.json
SQLFILE=/tmp/stall-detect.sql
STALE_SECS="${STALE_SECS:-7200}"   # >2h without activity = stale candidate

usage() {
  cat <<'EOF'
usage: stall-detect.sh [--merge db-results.json]
  Phase 1 (no args): shell-reachable checks + emit /tmp/stall-detect.sql
  Phase 2 (--merge):  combine muse.db JSON results with phase-1 data, report.
Diagnose only. Never kills.
EOF
}

now_epoch() { date +%s; }

# ---------- phase 1: shell-reachable checks ----------
phase1() {
  local now; now="$(now_epoch)"
  local tmp; tmp="$(mktemp)"
  {
    echo "{"
    echo "  \"generated_at\": $now,"
    echo "  \"yote\": {"
    if [ -x "$YOTE_CONN" ]; then
      "$YOTE_CONN" exec '
        echo "    \"tmux\": "; tmux ls 2>&1 | head -5 | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))"; echo ","
        echo "    \"oracle_lock_holder\": "; fuser -v /home/toxic/sovereign/agents/oracle-market/oracle.lock 2>&1 | tail -2 | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()[:200]))"; echo ","
        echo "    \"oracle_last_settled_age_s\": "; python3 - <<PY 2>/dev/null || echo null
import json, glob, time
best = None
for f in glob.glob("/home/toxic/sovereign/agents/oracle-market/ledger/*.jsonl"):
    try:
        for line in open(f):
            try: d = json.loads(line)
            except: continue
            if d.get("event") in ("settled","bid_accepted") and isinstance(d.get("ts"), (int,float)):
                if best is None or d["ts"] > best: best = d["ts"]
    except: pass
print(int(time.time()-best) if best else "null")
PY
        echo ","
        echo "    \"bidder_procs\": "; ps -eo pid,etime,cmd | grep "[b]idder.py" | python3 -c "import sys,json; print(json.dumps([l.strip()[:120] for l in sys.stdin]))"; echo ","
        echo "    \"herd_health\": "; curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:25100/health 2>/dev/null || echo "\"unreachable\""
      ' 2>/dev/null | sed 's/^ *$//'
    else
      echo '    "yote_connu": "missing",'
    fi
    echo "  },"
    echo "  \"cell\": {"
    echo "    \"load1\": $(cut -d' ' -f1 /proc/loadavg),"
    echo "    \"note\": \"cell-side agent processes execute elsewhere; use muse.db, not ps\""
    echo "  }"
    echo "}"
  } > "$tmp"
  # validate JSON; keep previous file if invalid
  if python3 -c "import json; json.load(open('$tmp'))" 2>/dev/null; then
    mv "$tmp" "$PHASE1"
  else
    rm -f "$tmp"
    echo "WARN: phase-1 yote probe produced invalid JSON; keeping old $PHASE1 if present" >&2
  fi
  emit_sql
  echo "phase 1 done -> $PHASE1 ; queries -> $SQLFILE"
  echo "Next: run the queries in $SQLFILE through muse.db, save results as"
  echo '  {"q1":[...],"q2":[...],"q3":[...],"q4":[...],"q5":[...],"q6":[...],"q7":[...]}'
  echo "  then: stall-detect.sh --merge db-results.json"
}

# ---------- the exact bounded queries (all row/byte/time bounded; the big
# context_items join is deliberately avoided — it lock-times-out under load) ----------
emit_sql() {
  local now; now="$(now_epoch)"
  local stale_cut=$((now - STALE_SECS))
  local day_cut=$((now - 86400))
  cat > "$SQLFILE" <<EOF
-- q1: status census
SELECT status AS s, count(*) AS n, min(updated_at) AS oldest_epoch, max(updated_at) AS newest_epoch FROM agent.agents GROUP BY status ORDER BY n DESC;
-- q2: running agents with stale agent-table rows (> ${STALE_SECS}s). NOTE: updated_at is
-- LAZY (not bumped on context writes) -> every hit here MUST be re-checked against q5.
SELECT agent_id AS aid, kind AS k, depth AS d, agent_type AS t, updated_at AS upd FROM agent.agents WHERE status = 'running' AND updated_at < ${stale_cut} ORDER BY updated_at;
-- q3: errored agents
SELECT agent_id AS aid, kind AS k, depth AS d, parent_agent_id AS par, created_at AS cr, updated_at AS up FROM agent.agents WHERE status = 'errored' ORDER BY updated_at DESC LIMIT 20;
-- q4: failed subagent.spawn attempts in the last 24h (the lock-timeout signature)
SELECT child_agent_id AS ch, parent_agent_id AS par, tool_name AS tn, tool_status AS ts, created_at AS cr, left(coalesce(tool_result_preview,''),300) AS prev FROM agent.subagent_progress_tool_events WHERE tool_name = 'subagent.spawn' AND tool_status = 'failed' AND created_at > ${day_cut} ORDER BY created_at DESC LIMIT 30;
-- q5 TEMPLATE: true last-activity per candidate. Substitute <IDS> with q2 agent_ids
-- (batched, IN-list keeps the planner on the index; the unfiltered join times out):
-- SELECT aid AS ch, last_item FROM (SELECT a.agent_id AS aid, max(c.created_at) AS last_item FROM agent.agents a LEFT JOIN agent.context_items c ON c.agent_id = a.agent_id WHERE a.agent_id IN (<IDS>) GROUP BY a.agent_id) q ORDER BY last_item;
-- q6 TEMPLATE: progress-event activity for candidates whose context is empty
-- (spawned children surface here even when their own context_items are empty):
-- SELECT child_agent_id AS ch, count(*) AS evs, max(created_at) AS last_ev FROM agent.subagent_progress_tool_events WHERE child_agent_id IN (<IDS>) GROUP BY child_agent_id ORDER BY last_ev;
-- q7 TEMPLATE: last tool call per candidate — distinguishes a worker that finished
-- its turn (nothing_to_do / final tool_output) from one stuck mid-tool:
-- SELECT agent_id AS ch, tool_name AS tn, success AS ok, created_at AS cr FROM agent.context_items WHERE agent_id IN (<IDS>) AND item_kind IN ('tool_call','tool_output') ORDER BY seq DESC LIMIT 40;
EOF
  echo "sql written to $SQLFILE"
}

# ---------- phase 2: merge + verdicts ----------
merge_report() {
  local dbjson="$1"
  [ -f "$dbjson" ] || { echo "no such file: $dbjson" >&2; exit 2; }
  [ -f "$PHASE1" ] || { echo "run phase 1 first (no --merge)" >&2; exit 2; }
  python3 - "$dbjson" "$PHASE1" <<'PY'
import json, sys, time
db = json.load(open(sys.argv[1]))
p1 = json.load(open(sys.argv[2]))
now = int(time.time())
STALE = int(__import__('os').environ.get('STALE_SECS', '7200'))

def age_str(s):
    if s is None: return "never"
    h, r = divmod(int(s), 3600); m = int(r//60)
    return f"{h}h{m:02d}m" if h else f"{m}m"

print("=" * 78)
print("STALL-DETECT REPORT  (diagnose only — nothing was killed, stopped, or closed)")
print(f"generated {time.strftime('%Y-%m-%d %H:%M %Z', time.localtime(now))} | stale threshold {STALE//3600}h")
print("=" * 78)

# ---- census
print("\n[agent census]")
for r in db.get("q1", []):
    n = r.get("n"); s = r.get("s")
    print(f"  {s:12s} {n:5d}  oldest_row_age={age_str(now-r['oldest_epoch']) if r.get('oldest_epoch') else '?'}")

# ---- candidates
cands = {r["aid"]: r for r in db.get("q2", []) if r.get("aid")}
act = {r.get("ch"): r.get("last_item") for r in db.get("q5", [])} if "q5" in db else {}
pev = {r.get("ch"): r.get("last_ev") for r in db.get("q6", [])} if "q6" in db else {}
# q7: last tool call per candidate -> finished-turn vs stuck-mid-tool
# (prefer the tool_call row for the name; tool_output carries the success flag)
lasttool = {}
if "q7" in db:
    for r in db["q7"]:
        ch = r.get("ch")
        prev = lasttool.get(ch)
        if prev is None:
            lasttool[ch] = (r.get("tn"), r.get("ok"))
        elif r.get("tn") and prev[0] is None:
            lasttool[ch] = (r.get("tn"), prev[1])
        elif r.get("ok") is not None and prev[1] is None:
            lasttool[ch] = (prev[0], r.get("ok"))
print(f"\n[stale-row candidates: {len(cands)}] (agent-table updated_at stale; re-checked vs real activity)")
for aid, r in sorted(cands.items(), key=lambda kv: kv[1].get("upd", 0)):
    li = act.get(aid); pe = pev.get(aid)
    best = None
    for v in (li, pe):
        if v is None: continue
        ts = int(v) if isinstance(v, (int, float)) else None
        if ts and (best is None or ts > best): best = ts
    # li from q5 is ISO text; handle it
    if isinstance(li, str) and li:
        try:
            import datetime
            ts = int(datetime.datetime.fromisoformat(li.replace("Z", "+00:00")).timestamp())
            if best is None or ts > best: best = ts
        except Exception: pass
    real_age = now - best if best else None
    tn, ok = lasttool.get(aid, (None, None))
    finished_turn = (tn == "nothing_to_do") or ok is True
    if best is None:
        verdict = "IDLE-DONE-COSMETIC? (no activity rows at all — verify kind before acting)"
        resume = "no action; row likely cosmetic. If kind=worker and task complete, parent reaps it."
    elif real_age > STALE and finished_turn:
        verdict = ("IDLE-DONE (wake-on-event worker; last turn ended cleanly "
                   f"{age_str(real_age)} ago, last tool={tn})")
        resume = ("no action. Status row stays 'running' by design for wake-on-sync workers; "
                  "status='running' + finished last turn != stalled.")
    elif real_age > STALE:
        verdict = "STALLED — last real activity " + age_str(real_age) + " ago"
        resume = ("safe resume: do NOT kill. Send the PARENT agent a nudge naming this child "
                  "and its last activity; or wait for its wake trigger (sync/event-driven).")
    else:
        verdict = f"ACTIVE (real activity {age_str(real_age)} ago; agent-table row was just lazy)"
        resume = "no action."
    print(f"  {aid[:8]} kind={r.get('k')} depth={r.get('d')} type={r.get('t')}")
    print(f"    verdict : {verdict}")
    print(f"    resume  : {resume}")

# ---- errored
# NOTE: failed subagent.spawn events are recorded against the SPAWNING PARENT
# (q4.ch = parent agent), not the dead child. Join by parent id + time proximity.
errs = db.get("q3", [])
fails = db.get("q4", [])
matched_fail = set()
for r in errs:
    aid = r.get("aid"); par = r.get("par"); cr = r.get("cr") or 0; up = r.get("up") or 0
    f = None
    for i, cand in enumerate(fails):
        if i in matched_fail: continue
        if cand.get("ch") == par and abs((cand.get("cr") or 0) - up) < 600:
            f = cand; matched_fail.add(i); break
    sig = (f.get("prev") if f else "") or ""
    if "lock timeout" in sig:
        verdict = "ERRORED-SPAWN — spawn transaction hit a DB lock timeout during contention"
        resume = ("safe resume: check the parent for retry children spawned AFTER this failure "
                  "(same task, newer created_at). If covered, ignore this row. If not, ask the "
                  "parent to re-issue the spawn. Never retry the dead child itself.")
    elif f:
        verdict = "ERRORED-SPAWN — spawn failed; see evidence"
        resume = "safe resume: have the parent re-issue the task; treat the dead row as read-only."
    else:
        verdict = "ERRORED — no matching spawn-failure event; inspect parent transcript"
        resume = "safe resume: have the parent re-issue the task; treat the dead row as read-only."
    print(f"  {aid[:8]} kind={r.get('k')} parent={str(par)[:8]} lived={up-cr}s")
    print(f"    verdict : {verdict}")
    print(f"    resume  : {resume}")
    if sig: print(f"    evidence: {sig[:160]}")

# ---- failed spawns without errored rows (parent retried inline)
orphan_fails = [f for i, f in enumerate(fails) if i not in matched_fail]
if orphan_fails:
    print(f"\n[failed spawn attempts not materialized as errored rows: {len(orphan_fails)}]")
    for f in orphan_fails:
        print(f"  parent={str(f.get('ch'))[:8]} at epoch {f.get('cr')} :: {(f.get('prev') or '')[:140]}")

# ---- yote live state
y = p1.get("yote", {})
print("\n[yote live state]")
print(f"  oracle.lock holder : {(y.get('oracle_lock_holder') or 'n/a').strip()[:80]}")
sa = y.get("oracle_last_settled_age_s")
print(f"  oracle last settle : {'n/a' if sa is None else age_str(sa)+' ago'}")
print(f"  bidder procs       : {len(y.get('bidder_procs') or [])} alive")
print(f"  herd :25100        : {y.get('herd_health')}")
print(f"  tmux               : {y.get('tmux')}")
if isinstance(sa, (int, float)) and sa > 7200:
    print("  NOTE: oracle idle >2h — cross-check whether intake is expected (event-driven, may be normal).")
print("\nEND REPORT — diagnose only. No process, agent, or job was touched.")
PY
}

case "${1:-}" in
  --merge) [ -n "${2:-}" ] || { usage; exit 2; }; merge_report "$2" ;;
  -h|--help) usage ;;
  "") phase1 ;;
  *) usage; exit 2 ;;
esac
