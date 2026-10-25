#!/usr/bin/env python3
"""
Hearth's eyes on yote: single-pass progress snapshot, JSON to stdout.

Covers: oracle-market loop, ledger growth, stuck tasks, bidder daemons,
core pitchfork daemons + health, bridge holder. Never changes anything.
Channel dir can be overridden with argv[1] (used by --selftest).
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

def _resolve_pf():
    """Resolve the pitchfork binary without a version-pinned path.

    Order: live supervisor's own exe (can never skew vs the supervisor
    pitchfork must talk to) -> mise `latest` symlink (tracks newest
    install) -> mise shim -> /usr/bin fallback. Survives mise upgrades
    (e.g. 2.25.0 -> 2.27.0) without edits. (ember, 2026-09-20)
    """
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            cmdline = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode()
        except OSError:
            continue
        if "pitchfork supervisor run" in cmdline:
            try:
                exe = os.readlink(proc / "exe")
            except OSError:
                continue
            if exe.endswith("/pitchfork") and Path(exe).is_file():
                return exe
    for cand in (
        "/home/toxic/.local/share/mise/installs/pitchfork/latest/pitchfork",
        "/home/toxic/.local/share/mise/shims/pitchfork",
        "/usr/bin/pitchfork",
    ):
        if Path(cand).is_file():
            return cand
    return "/home/toxic/.local/share/mise/installs/pitchfork/latest/pitchfork"


PF = _resolve_pf()
LEDGER = Path("/home/toxic/pens/ranch/oracle/ledger/ledger.jsonl")
PLOF = ["tau-1826-health", "super-ralph-e2e"]
DAEMONS = {
    "kimi-auto-shim": 25153,
    "beellama-fast": 25122,
    "whatsapp-mcp": 25146,
    "toolcall-llm": 25152,
    "stoat": 25104,
    # 2026-09-29: herd/model-guard/gatehouse were invisible to the watchdog;
    # herd sat stopped ~8h (gatehouse dep) with no alert. Added for coverage.
    "herd": 25100,
    "model-guard": 25101,
    "gatehouse": 25127,
}
STUCK_UNSEEN_S = 180      # task_post with no ledger trace older than this
STUCK_WEDGED_S = 1800     # task_open but no terminal event older than this
TRIAGE_WINDOW_S = 900     # an intake_request must get its own
                          # intake-decision within this window of its mtime;
                          # validated 2026-09-20: 6/6 historical intakes
                          # triaged in ~1s, none older than 900s was pending

out = {"ts": time.time(), "errors": []}
channel = Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] != "--selftest" \
    else Path("/home/toxic/estate/hatch/agents/ember/squawk-root/bid-market")


def sh(cmd, timeout=15):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"sh {' '.join(cmd[:2])}: {type(e).__name__}")
        return ""


def pf_statuses():
    # None when `pitchfork list` fails/returns nothing, so callers can
    # distinguish "lookup failed" from "daemon not registered".
    raw = sh([PF, "list"])
    if not raw.strip():
        return None
    stats = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2 and "/" in parts[0]:
            stats[parts[0]] = parts[1]
    return stats


def parse_frontmatter(path):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    meta = {}
    for line in parts[1].splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta


def load_ledger(path=LEDGER):
    events = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError as e:
        out["errors"].append(f"load_ledger {path}: {type(e).__name__}")
    return events


def health(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health",
                                    timeout=5) as r:
            return r.status
    except Exception as e:  # noqa: BLE001
        return f"ERR:{type(e).__name__}"


def _intake_tokens(path):
    toks = set(re.findall(r"intake-\d{10,13}", path.name))
    toks.update(re.findall(r"\b\d{10,13}\b", path.name))
    meta = parse_frontmatter(path)
    for key in ("task_id", "title"):
        v = (meta.get(key) or "").strip().strip('"')
        if v:
            toks.add(v)
    return toks, (meta.get("from") or "").strip()


def intake_backlog(chan_dir, ledger_events, now):
    """Per-request intake backlog (kept separate so tests can pin it).

    A file is handled only if an intake-decision for THAT request lands
    within TRIAGE_WINDOW_S of the file's mtime — a later unrelated
    decision must not mask a stale intake. Each decision is consumed by
    at most one file (earliest mtime first). Files younger than 120s
    get inotify grace; files within the triage window are still owed
    time. Returns (backlog, self_from, legacy): [{"file", "age_s"}] for
    files older than TRIAGE_WINDOW_S with no matching decision, plus
    self-from intakes (invisible to ingest by design) and legacy intakes
    that predate the current ledger epoch.
    """
    backlog = []
    self_from = []
    legacy = []
    if not chan_dir.is_dir():
        return backlog, self_from, legacy
    # ledger-rotation guard (2026-09-30): intake-decisions live only in the
    # ledger. After a rotation the triage state of older intakes is
    # unknowable -- and the inotify-driven loop never revisits pre-existing
    # files, so they are dead letters, not a wedged oracle. Intakes older
    # than the oldest ledger event belong to a previous epoch: reported as
    # legacy, not backlog.
    ledger_first_ts = min((e.get("ts", 0) for e in ledger_events),
                          default=0)
    decisions = sorted(
        (e for e in ledger_events if e.get("event") == "intake-decision"),
        key=lambda e: e.get("ts", 0))
    used = set()
    intakes = []
    for name in sorted(os.listdir(chan_dir)):
        if not name.endswith(".md"):
            continue
        p = chan_dir / name
        if parse_frontmatter(p).get("msg_type") != "intake_request":
            continue
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        intakes.append((mtime, name, p))
    for mtime, name, p in sorted(intakes):
        age = now - mtime
        if age < 120:
            continue  # grace for inotify latency
        if ledger_first_ts and mtime < ledger_first_ts:
            legacy.append({"file": name, "age_s": round(age)})
            continue  # previous ledger epoch: triage state unknowable
        toks, frm = _intake_tokens(p)
        # 2026-09-21 (hearth): self-from intakes (from oracle-market/oracle)
        # are invisible to ingest() by design (SELF_FROMS) and can NEVER be
        # triaged -- flagging them as backlog re-alerts forever on legacy
        # residue (e.g. 100316, posted by the pre-fix pump under the default
        # identity). Track them separately; do not count as backlog.
        if frm in ("oracle-market", "oracle"):
            self_from.append({"file": name, "age_s": round(age)})
            continue
        handled = False
        for i, d in enumerate(decisions):
            if i in used:
                continue
            dts = d.get("ts", 0)
            if not (mtime - 5 < dts <= mtime + TRIAGE_WINDOW_S):
                continue
            if (frm and d.get("from") == frm) or \
                    any(t in json.dumps(d) for t in toks):
                handled = True
                used.add(i)
                break
        if not handled and age > TRIAGE_WINDOW_S:
            backlog.append({"file": name, "age_s": round(age)})
    return backlog, self_from, legacy


def snapshot(chan_dir, ledger_events):
    now = time.time()
    snap = {}
    pf = pf_statuses()
    snap["pf_ok"] = pf is not None
    if pf is not None:
        def pfget(k):
            return pf.get(k, "missing")
    else:
        def pfget(k):
            return "unknown"

    # --- oracle loop liveness + per-request intake backlog ---
    # A quiet market is healthy: ledger age alone cannot tell "loop
    # dead/wedged" from "no demand" (2026-09-20: a 21,050s gap was a
    # loop_stop/loop_start boundary with zero intake files present, not a
    # wedge — and the earlier "stalled 24,206s" read was ledger age, not a
    # validated outage). So report the process AND correlate each
    # intake_request file individually against its own intake-decision.
    # A file is handled only if a decision for THAT request lands within
    # TRIAGE_WINDOW_S of the file's mtime (validated 2026-09-20: 6/6
    # intakes triaged in ~1s with matching `from`). Each decision is
    # consumed by at most one file (earliest mtime first).
    ostat = pfget("estate/oracle-market")
    oracle_proc = {"running": False, "pid": None, "uptime_s": None}
    for line in sh(["pgrep", "-f",
                    "[o]racle/bin/oracle_loop.py"]).splitlines():
        line = line.strip()
        if line.isdigit():
            pid = int(line)
            el = sh(["ps", "-o", "etimes=", "-p", str(pid)]).strip()
            oracle_proc = {"running": True, "pid": pid,
                           "uptime_s": int(el) if el.isdigit() else None}
            break
    snap["oracle"] = {"pitchfork": ostat, "proc_alive": oracle_proc["running"],
                      "proc": oracle_proc}

    # --- ledger ---
    by_tid = {}
    for e in ledger_events:
        tid = e.get("task_id")
        if tid:
            by_tid.setdefault(tid, set()).add(e.get("event"))
    last_ts = max((e.get("ts", 0) for e in ledger_events), default=0)
    w30 = [e for e in ledger_events if now - e.get("ts", 0) < 1800]
    w1h = [e for e in ledger_events if now - e.get("ts", 0) < 3600]
    wins = {}
    for e in w30:
        if e.get("event") == "settled" and e.get("verified"):
            w = e.get("winner", "?")
            wins[w] = wins.get(w, 0) + 1
    plof = {}
    for tid in PLOF:
        evs = by_tid.get(tid, set())
        if "settled" in evs:
            plof[tid] = ("settled-verified" if any(
                e.get("event") == "settled" and e.get("verified")
                for e in ledger_events if e.get("task_id") == tid)
                else "settled-unverified")
        elif "task_open" in evs:
            plof[tid] = "open"
        elif "no_assign" in evs:
            plof[tid] = "no-assign"
        else:
            plof[tid] = "missing"
    snap["ledger"] = {
        "lines": len(ledger_events),
        "last_ts": last_ts,
        "last_age_s": round(now - last_ts, 1) if last_ts else None,
        "open_30m": sum(1 for e in w30 if e.get("event") == "task_open"),
        "settled_30m": sum(1 for e in w30 if e.get("event") == "settled"),
        "verified_30m": sum(1 for e in w30
                             if e.get("event") == "settled" and e.get("verified")),
        "no_assign_30m": sum(1 for e in w30 if e.get("event") == "no_assign"),
        "settled_1h": sum(1 for e in w1h if e.get("event") == "settled"),
        "wins_30m": wins,
        "proof_of_life": plof,
        "intake_backlog": None,  # filled below
    }
    _bl, _sf, _lg = intake_backlog(chan_dir, ledger_events, now)
    snap["ledger"]["intake_backlog"] = _bl  # was top-level: left ledger key None
    snap["ledger"]["intake_self_from"] = _sf  # which crashed the hatch watchdog
    snap["ledger"]["intake_legacy"] = _lg  # pre-rotation dead letters

    # --- stuck tasks ---
    # ledger-rotation guard (2026-09-30): the market loop restarted with a
    # fresh ledger at 00:37 and the old task_open/bid/settle history went
    # with it. The channel dir itself is the durable record: a task_id seen
    # in any non-task_post file (bid, assign, settle, no-assign, result,
    # next-work) was processed under a previous ledger epoch and is NOT
    # unseen -- flagging it re-alerts on rotation residue and burns the
    # re-announce budget re-posting dead work.
    stuck = []
    processed_tids = set()
    task_posts = []
    if chan_dir.is_dir():
        for name in sorted(os.listdir(chan_dir)):
            if not name.endswith(".md"):
                continue
            meta = parse_frontmatter(chan_dir / name)
            if meta.get("msg_type") == "task_post":
                task_posts.append((name, meta))
            elif meta.get("task_id"):
                processed_tids.add(meta["task_id"])
    for name, meta in task_posts:
        tid = meta.get("task_id", "")
        if not tid:
            continue
        age = now - (chan_dir / name).stat().st_mtime
        evs = by_tid.get(tid, set())
        if "task_open" not in evs and tid not in processed_tids \
                and age > STUCK_UNSEEN_S:
            stuck.append({"task_id": tid, "kind": "unseen",
                          "age_s": round(age), "file": name})
        elif "task_open" in evs and not (evs & {"settled", "no_assign"}) \
                and age > STUCK_WEDGED_S:
            stuck.append({"task_id": tid, "kind": "wedged",
                          "age_s": round(age), "file": name})
    snap["stuck_tasks"] = stuck

    # --- bidders ---
    # pgrep is process ground truth: pitchfork status can desync (2026-09-29:
    # the no-op idempotent launcher exits 0 while a live bidder from an
    # older generation still holds the hodos, leaving pitchfork at
    # "stopped" with a healthy bidder running). Report both; the hatch
    # watchdog restarts only when neither is alive.
    bidders = []
    for name, status in sorted(pf.items()):
        if not name.startswith("estate/bidder-"):
            continue
        short = name.split("/", 1)[1]
        bid = short.split("-", 1)[1] if "-" in short else short
        act = Path(f"/tmp/{short}.activity")
        age = round(now - act.stat().st_mtime, 1) if act.exists() else None
        proc = bool(sh(["pgrep", "-f", f"[b]idder.py --id {bid}"]))
        bidders.append({"name": name, "status": status,
                        "proc_running": proc,
                        "activity_age_s": age})
    snap["bidders"] = bidders

    # --- core daemons ---
    daemons = {}
    for name, port in DAEMONS.items():
        daemons[name] = {"pitchfork": pfget(f"estate/{name}"),
                         "health": health(port)}
    # bridge daemon expected stopped-clean; holder alive is what matters
    daemons["awrawr-ws-exec"] = {
        "pitchfork": pfget("estate/awrawr-ws-exec")}
    snap["daemons"] = daemons

    # --- bridge holder ---
    # 2026-09-20: bridge moved 8379 -> 25204 (tailscale serve /exec-ws backend);
    holder = {"listening": False, "pid": None, "alive": False,
              "cmd_ok": False}
    m = re.search(r"pid=(\d+)", sh(["ss", "-ltnp", "sport = :25204"]))
    if m:
        holder["listening"] = True
        pid = m.group(1)
        holder["pid"] = int(pid)
        try:
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
            holder["alive"] = True
            holder["cmd_ok"] = b"awrawr_ws_exec" in cmd
        except OSError:
            pass
    snap["bridge"] = holder
    return snap


def selftest():
    import tempfile
    tmp = Path(tempfile.mkdtemp(prefix="hearth-test-"))
    now = time.time()
    # unseen stuck task: task_post file, no ledger trace, old
    f1 = tmp / "00001-tester-task-post-old.md"
    f1.write_text("---\nmsg_type: task_post\ntask_id: stuck-unseen-1\n"
                  "---\n{\"task_id\": \"stuck-unseen-1\"}")
    os.utime(f1, (now - 600, now - 600))
    # fresh task: not stuck
    f2 = tmp / "00002-tester-task-post-fresh.md"
    f2.write_text("---\nmsg_type: task_post\ntask_id: fresh-1\n"
                  "---\n{\"task_id\": \"fresh-1\"}")
    # wedged task: task_open in ledger, no terminal event, old file
    f3 = tmp / "00003-tester-task-post-wedged.md"
    f3.write_text("---\nmsg_type: task_post\ntask_id: wedged-1\n"
                  "---\n{\"task_id\": \"wedged-1\"}")
    os.utime(f3, (now - 4000, now - 4000))
    led = [{"event": "task_open", "task_id": "wedged-1", "ts": now - 4000},
           {"event": "task_open", "task_id": "fresh-1", "ts": now - 10}]
    snap = snapshot(tmp, led)
    kinds = sorted((s["task_id"], s["kind"]) for s in snap["stuck_tasks"])
    print(json.dumps({"selftest_stuck": kinds,
                      "selftest_ledger_lines": snap["ledger"]["lines"]}))
    assert kinds == [("stuck-unseen-1", "unseen"), ("wedged-1", "wedged")], \
        f"FAIL: {kinds}"
    print("SELFTEST PASS")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        out.update(snapshot(channel, load_ledger()))
        print(json.dumps(out))
