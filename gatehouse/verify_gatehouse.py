#!/usr/bin/env python3
"""verify_gatehouse.py — Gatehouse MCP fleet verification harness.

Catches two failure classes found on the estate (2026-10-13):
  1. Silent drift: live mcp_config.json (gitignored) diverges from the
     durable mcp_config.json.dist, so servers added live die on restart.
  2. DEAD-EMPTY servers: a server shows "running"/enabled while its config
     args point at a directory instead of the entry file, so tools/list
     returns zero tools and every call fails empty.

Sections:
  INVENTORY — parse live + dist configs; report counts, live-only servers
             (restart-survival risk), dist-only servers, per-entry drift.
  LIVENESS  — for each enabled server: tools/list via the Gatehouse client.
             Zero tools or an error => DEAD-EMPTY.
  PROBE     — call one deterministically-chosen read-only safe tool per
             live server (status|ping|health|list|info|version|ls); record
             ok/fail + latency. Mutating tools are never called.

Usage:
  python3 verify_gatehouse.py [--quick] [--out report.json]
    --quick   skip PROBE (inventory + liveness only)
    --out     also write the JSON report to a file

Exit 1 if any enabled server is DEAD-EMPTY or any live-only drift exists,
else 0. JSON goes to stdout; the human summary goes to stderr so stdout
stays machine-parseable. Read-only throughout: no restarts, no config edits.
"""

import argparse
import concurrent.futures
import json
import re, os
import subprocess
import sys
import time
from pathlib import Path

BASE = Path("/home/toxic/estate/ranch/barn/gatehouse")
LIVE_CFG = BASE / "mcp_config.json"
DIST_CFG = BASE / "mcp_config.json.dist"
CLIENT = Path("/home/toxic/.local/bin/gatehouse-client.py")

CALL_DEADLINE_S = 60
WORKERS = 6

# Entry fields compared for drift (volatile timestamps excluded).
DRIFT_FIELDS = ("command", "args", "env", "protocol", "oauth")

SAFE_TOOL_RE = re.compile(
    r"(?i)(?:^|[^a-z0-9])(status|ping|health|list|info|version|ls|capabilities)"
    r"(?:$|[^a-z0-9])")
ARG_ERR_RE = re.compile(
    r"(?i)(invalid arguments|missing (required |)arguments?|"
    r"required parameter|requires? arguments?)")
DANGER_TOOL_RE = re.compile(
    r"(?i)(kill|delete|remove|destroy|write|create|update|post|send|exec|run|"
    r"deploy|push|commit|restart|stop|start|terminate|drop|truncate|publish)")


def fail(msg):
    print(f"verify_gatehouse: {msg}", file=sys.stderr)
    sys.exit(2)


def run_client(op, args, deadline=CALL_DEADLINE_S):
    """Invoke the yote-side Gatehouse client; return (rc, stdout, err_text)."""
    try:
        p = subprocess.run(
            [sys.executable, str(CLIENT), op, *args],
            capture_output=True, text=True, timeout=deadline)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, "", f"client call '{op}' exceeded {deadline}s"
    except Exception as e:  # noqa: BLE001
        return 1, "", f"client invocation failed: {e}"


# ---------------------------------------------------------------- inventory
def load_index(path):
    try:
        cfg = json.loads(path.read_text())
    except Exception as e:  # noqa: BLE001
        fail(f"cannot parse {path}: {e}")
    servers = cfg.get("mcpServers") or []
    if isinstance(servers, dict):
        servers = [{"name": k, **v} for k, v in servers.items()]
    return {s.get("name"): s for s in servers if isinstance(s, dict)
            and s.get("name")}


def norm_entry(entry):
    """Normalized JSON for drift comparison of DRIFT_FIELDS + enabled."""
    out = {}
    for f in DRIFT_FIELDS:
        v = entry.get(f)
        out[f] = json.dumps(v, sort_keys=True, default=str)
    out["enabled"] = bool(entry.get("enabled"))
    return out


def inventory():
    live = load_index(LIVE_CFG)
    dist = load_index(DIST_CFG)
    live_names, dist_names = set(live), set(dist)
    live_only = sorted(live_names - dist_names)
    dist_only = sorted(dist_names - live_names)
    drift = []
    for name in sorted(live_names & dist_names):
        a, b = norm_entry(live[name]), norm_entry(dist[name])
        diffs = [f for f in a if a[f] != b[f]]
        if diffs:
            drift.append({"server": name, "fields": diffs})
    return {
        "live_count": len(live), "dist_count": len(dist),
        "live_only": live_only, "dist_only": dist_only,
        "entry_drift": drift,
        "_live": live, "_dist": dist,
    }


def enabled_from_cli():
    """Servers the proxy itself reports, with disabled flags."""
    rc, out, err = run_client("servers", [])
    if rc != 0:
        fail(f"'servers' failed: {err or out}")
    enabled, disabled = [], []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.endswith("[disabled]"):
            disabled.append(line[:-len("[disabled]")].strip())
        else:
            enabled.append(line)
    return enabled, disabled


# ----------------------------------------------------------------- liveness
_LIVE_ENTRIES = {}


def config_hint(server):
    """Short triage note from the live config entry for a DEAD-EMPTY server."""
    e = _LIVE_ENTRIES.get(server) or {}
    proto = e.get("protocol") or "?"
    args = e.get("args") or []
    tgt = args[0] if args else None
    if tgt:
        if os.path.isdir(tgt):
            st = "args0-is-DIRECTORY (classic silent-death signature)"
        elif os.path.isfile(tgt):
            st = "args0 target file exists"
        else:
            st = f"args0 target {'not-a-path' if not tgt.startswith('/') else 'MISSING'}"
        return f"proto={proto} cmd={e.get('command')} args0={tgt[:80]} -> {st}"
    return (f"proto={proto} cmd={e.get('command')} args={json.dumps(args)[:80]} "
            f"(no file target to stat)")


def server_tool_names(server):
    """(ok, [tool_full_names], detail). ok=False => DEAD-EMPTY."""
    rc, out, err = run_client("tools", [server])
    if rc != 0:
        return False, [], f"tools/list failed (rc={rc}): {err or out}"
    names = []
    for line in out.splitlines():
        head = line.split("|", 1)[0].strip()
        if head.startswith(server + ":"):
            names.append(head)
    if not names:
        n = len([l for l in out.splitlines() if l.strip()])
        return (False, [],
                f"0 of {n} listed tool lines prefixed '{server}:' "
                f"(first lines: {out[:200]!r})")
    return True, names, ""


def pick_safe_tool(names):
    """Deterministic first tool whose base name looks read-only and carries
    no mutating verb. Returns None with a reason when nothing qualifies."""
    for full in names:
        base = full.split(":", 1)[1] if ":" in full else full
        if SAFE_TOOL_RE.search(base) and not DANGER_TOOL_RE.search(base):
            return full, ""
    return None, "no safe read-only tool (no status|ping|health|list|info|version|ls without mutating verbs)"


def probe(tool_full):
    """Call the safe tool with {}.

    Returns (ok, latency_ms, detail, argument_error). An argument-validation
    payload with rc=0 proves the server is alive (it parsed and answered),
    so it is ok=True with argument_error=True rather than a failure."""
    t0 = time.perf_counter()
    rc, out, err = run_client("call", [tool_full, "{}"])
    ms = int((time.perf_counter() - t0) * 1000)
    if rc != 0:
        return False, ms, f"call failed (rc={rc}): {(err or out)[:300]}", False
    body = (out or "")[:300]
    arg_err = bool(ARG_ERR_RE.search(body))
    return True, ms, body, arg_err


def assess_server(server, quick):
    rec = {"server": server, "tools": 0, "dead_empty": False,
           "probe": None}
    ok, names, detail = server_tool_names(server)
    if not ok:
        rec["dead_empty"] = True
        rec["dead_detail"] = detail
        rec["config_hint"] = config_hint(server)
        return rec
    rec["tools"] = len(names)
    if quick:
        rec["probe"] = {"skipped": True, "reason": "--quick"}
        return rec
    picked, reason = pick_safe_tool(names)
    if picked is None:
        rec["probe"] = {"skipped": True, "reason": reason}
        return rec
    ok, ms, detail, arg_err = probe(picked)
    rec["probe"] = {"tool": picked, "ok": ok,
                    "latency_ms": ms, "detail": detail,
                    "argument_error": arg_err}
    return rec


# -------------------------------------------------------------------- report
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    t0 = time.perf_counter()
    inv = inventory()
    live, dist = inv.pop("_live"), inv.pop("_dist")
    global _LIVE_ENTRIES
    _LIVE_ENTRIES = live
    enabled, cli_disabled = enabled_from_cli()

    # Config-vs-CLI disagreement is itself a signal (quarantine, drift).
    cfg_enabled = sorted(n for n, e in live.items() if e.get("enabled"))
    cli_set, cfg_set = set(enabled), set(cfg_enabled)
    cli_flag_disagreement = {
        "enabled_in_cli_only": sorted(cli_set - cfg_set),
        "enabled_in_config_only": sorted(cfg_set - cli_set),
    }

    assessments = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(assess_server, s, args.quick): s for s in enabled}
        for f in concurrent.futures.as_completed(futs):
            assessments.append(f.result())
    assessments.sort(key=lambda r: r["server"])

    dead_empty = [a["server"] for a in assessments if a["dead_empty"]]
    probe_fail = [a for a in assessments
                  if a.get("probe") and not a["probe"].get("skipped")
                  and not a["probe"].get("ok")]
    probe_argerr = [a["server"] for a in assessments
                    if a.get("probe") and a["probe"].get("ok")
                    and a["probe"].get("argument_error")]
    probe_skip = [(a["server"], a["probe"]["reason"]) for a in assessments
                  if a.get("probe") and a["probe"].get("skipped")]

    report = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "quick": args.quick,
        "inventory": inv,
        "cli_flag_disagreement": cli_flag_disagreement,
        "enabled_servers": len(enabled),
        "cli_disabled_servers": cli_disabled,
        "servers": assessments,
        "dead_empty": dead_empty,
        "probe_failures": [a["server"] for a in probe_fail],
        "probe_argument_errors": probe_argerr,
        "probe_skips": probe_skip,
        "exit_if": {"dead_empty": bool(dead_empty),
                    "live_only_drift": bool(inv["live_only"])},
        "duration_s": round(time.perf_counter() - t0, 1),
    }

    out = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(out + "\n")
    print(out)

    s = sys.stderr
    print(f"\nGATEHOUSE VERIFY — live={inv['live_count']} "
          f"dist={inv['dist_count']} enabled={len(enabled)} "
          f"dead_empty={len(dead_empty)} "
          f"probe_fail={len(probe_fail)} "
          f"({report['duration_s']}s)", file=s)
    if inv["live_only"]:
        print(f"  LIVE-ONLY (restart risk): {', '.join(inv['live_only'])}",
              file=s)
    if inv["dist_only"]:
        print(f"  DIST-ONLY: {', '.join(inv['dist_only'])}", file=s)
    for d in inv["entry_drift"]:
        print(f"  DRIFT {d['server']}: {', '.join(d['fields'])}", file=s)
    for n in dead_empty:
        d = next(a for a in assessments if a["server"] == n)
        print(f"  DEAD-EMPTY {n}: {d.get('dead_detail','')[:120]}", file=s)
        print(f"      config: {d.get('config_hint','')[:200]}", file=s)
    for a in probe_fail:
        p = a["probe"]
        print(f"  PROBE-FAIL {a['server']} via {p['tool']}: "
              f"{p['detail'][:160]}", file=s)
    if probe_argerr:
        print(f"  PROBE-ARGERR (alive, needs args): "
              f"{', '.join(probe_argerr)}", file=s)

    sys.exit(1 if (dead_empty or inv["live_only"]) else 0)


if __name__ == "__main__":
    main()
