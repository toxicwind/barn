#!/usr/bin/env python3
"""port-audit.py — hardened SSOT-vs-live port auditor.

Diffs the port SSOT (config/ports.env) against live listeners and classifies
every discrepancy by severity, so a real collision can never hide behind a
dynamic pool or a generic runtime name again.

Failure modes detected:

  1. DOUBLE-BOOKED — two unrelated names assigned the same port in
     config/ports.env. Known intentional alias groups (documented below) are
     NOT flagged.
  2. SQUATTERS — an SSOT port held by a process whose resolved identity
     (full /proc/<pid>/cmdline + ancestor chain, not just the 15-char comm)
     does not match the registered owner. This is how the 2026-09-20
     kimi-code split-brain was caught: a blind port-walk parked a duplicate
     instance on a port it did not own.
  3. LIVE BUT UNREGISTERED — a listener inside the service ranges that the
     SSOT knows nothing about. Warning by default; --strict escalates to a
     conflict.
  4. EXPECTED BUT DARK — SSOT ports with nothing listening. Informational;
     many daemons are optional.
  5. DYNAMIC POOL — live listeners inside the herd-dynamic pool
     (25001-25099, allocated at runtime per config/herd.yaml). Always
     informational, never a conflict.
  6. RANGE VIOLATION — an SSOT port outside User's mandated 25000-35000
     service range (8300-8399 tailscale-serve backends are grandfathered).
     Warning only; the port-range migration owns the fix.

Exit codes: 0 = clean, 1 = conflicts (double-booked or squatters, plus
unregistered under --strict), 2 = operational error (bad args, unreadable
SSOT, ss failed).

Run on demand or from an event-driven watcher — never on a timer.

Usage: bin/port-audit.py [--ssot PATH] [--json] [--strict]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SSOT = REPO_ROOT / "config" / "ports.env"

# Overridable for tests (point at a fixture /proc tree).
PROC_ROOT = "/proc"

# ---------------------------------------------------------------------------
# Static knowledge
# ---------------------------------------------------------------------------

# Intentional multi-name ports. A port whose registered names are ALL inside
# one of these groups is an alias, not a double-book. Verified 2026-09-20:
#   25100 — one live process (herd, pitchfork-supervised); HERD_PORT and
#           LLAMA_SWAP_PORT name the same service (herd serves via herd).
#   25107 — NULL_G_PORT is the documented deprecated forward-only alias of
#           NULL_G_PROXY_PORT (see ports.env).
#   25133 — QDRANT_PORT / QDRANT_HTTP_PORT are qdrant's single HTTP listener.
ALIAS_GROUPS = [
    frozenset({"LLAMA_SWAP_PORT", "HERD_PORT"}),
    frozenset({"NULL_G_PROXY_PORT", "NULL_G_PORT"}),
    frozenset({"QDRANT_PORT", "QDRANT_HTTP_PORT"}),
]

# Runtimes whose 15-char comm tells us nothing about the service. We do NOT
# skip these (the old audit did, which hid squatters) — instead we resolve
# the real identity via /proc/<pid>/cmdline + ancestry. Only when the cmdline
# is genuinely unreadable do we report "unattributed" instead of guessing.
GENERIC_RUNTIMES = {
    "bun", "node", "python", "python3", "deno", "java", "ruby",
    "MainThread",  # CPython threads surface under this comm name
}

# Infra ports outside the registry's business.
INFRA_IGNORE = {
    22, 53, 443, 631, 2222, 5037, 5355, 5432, 59818, 9090, 9749, 10200,
    20241, 42445, 43161, 57889, 58050, 58051, 60955,
}

# User's mandate: every service port lives in 25000-35000.
SERVICE_RANGE = (25000, 35000)
# Grandfathered: tailscale-serve backends (8377 /mcp, 8378 /gemini-mcp,
# 8379 /exec-ws, 8443 /). Still audited, but range violations are not raised.
LEGACY_RANGES = [(8300, 8399), (8443, 8443)]
# herd-dynamic pool: herd backends + herd-managed alias shims, allocated
# at runtime (config/herd.yaml startPort), never registered in the SSOT.
DYNAMIC_POOLS = [(25001, 25099)]


def in_ranges(port: int, ranges) -> bool:
    return any(lo <= port <= hi for lo, hi in ranges)


# ---------------------------------------------------------------------------
# SSOT parsing
# ---------------------------------------------------------------------------

def parse_ssot(path: Path):
    """Return ({port: [{name, owner, line}]}, warnings).

    owner comes from a trailing `# owner: ...` comment on the same line —
    it is the human-maintained attribution hint used for squatter matching.
    """
    by_port: dict[int, list[dict]] = {}
    warnings: list[str] = []
    try:
        lines = path.read_text().splitlines()
    except OSError as e:
        raise SystemExit(f"port-audit: cannot read SSOT {path}: {e}")
    for lineno, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # Split off the trailing comment first so values can't swallow it.
        code, _, comment = raw.partition("#")
        owner = None
        m_owner = re.search(r"owner:\s*(.+)", comment)
        if m_owner:
            owner = m_owner.group(1).strip()
        m = re.match(r"^\s*([A-Za-z0-9_]+)\s*=\s*[\"']?([^\"'#\s]+)", code)
        if not m:
            continue
        name, val = m.group(1), m.group(2)
        if not name.endswith("_PORT"):
            continue  # e.g. FLEET_POWER_INTERVAL — not a port
        try:
            port = int(val)
        except ValueError:
            warnings.append(
                f"{path}:{lineno}: {name} has non-numeric value {val!r}"
            )
            continue
        by_port.setdefault(port, []).append(
            {"name": name, "owner": owner, "line": lineno}
        )
    return by_port, warnings


def is_alias_port(names: list[str]) -> bool:
    """True when every registered name sits inside one known alias group."""
    name_set = set(names)
    return any(name_set <= set(group) for group in ALIAS_GROUPS)


# ---------------------------------------------------------------------------
# Live listener discovery + identity resolution
# ---------------------------------------------------------------------------

def live_listeners() -> dict[int, list[tuple[str, int]]]:
    """Return {port: [(comm, pid), ...]} for listening TCP sockets."""
    try:
        out = subprocess.run(
            ["ss", "-tlnp"], capture_output=True, text=True, check=False
        ).stdout
    except OSError as e:
        print(f"port-audit: ERROR running ss: {e}", file=sys.stderr)
        sys.exit(2)
    listeners: dict[int, list[tuple[str, int]]] = {}
    for line in out.splitlines():
        m = re.search(r":(\d+)\s", line)
        if not m:
            continue
        port = int(m.group(1))
        for name, pid in re.findall(r'\(\("([^"]+)",pid=(\d+)', line):
            entry = (name, int(pid))
            # ss can list the same pid twice (v4 + v6 binds); dedupe.
            if entry not in listeners.setdefault(port, []):
                listeners[port].append(entry)
    return listeners


def read_cmdline(pid: int) -> str | None:
    """Full command line for pid, space-joined; None when unreadable."""
    try:
        raw = Path(PROC_ROOT, str(pid), "cmdline").read_bytes()
    except OSError:
        return None
    parts = [p.decode("utf-8", "replace") for p in raw.split(b"\0") if p]
    return " ".join(parts) if parts else None


def proc_ppid(pid: int) -> int | None:
    """Parent pid from /proc/<pid>/stat (comm may contain spaces/parens)."""
    try:
        stat = Path(PROC_ROOT, str(pid), "stat").read_text()
    except OSError:
        return None
    # format: pid (comm) state ppid ...
    rparen = stat.rfind(")")
    if rparen == -1:
        return None
    fields = stat[rparen + 1 :].split()
    if len(fields) < 3:
        return None
    try:
        return int(fields[1])
    except ValueError:
        return None


def proc_comm(pid: int) -> str | None:
    try:
        return Path(PROC_ROOT, str(pid), "comm").read_text().strip() or None
    except OSError:
        return None


def resolve_identity(pid: int, ss_comm: str) -> dict:
    """Resolve who a listener really is.

    Returns {comm, cmdline, argv0, ancestry: [(pid, comm, cmdline_short)]}.
    ancestry walks the ppid chain (max 8) and always ends at the supervisor
    boundary (pitchfork / systemd) when visible — that attribution is often
    the most useful field in the report.
    """
    cmdline = read_cmdline(pid)
    argv0 = None
    if cmdline:
        argv0 = os.path.basename(cmdline.split()[0])
    ancestry: list[tuple[int, str, str]] = []
    seen = {pid}
    cur = proc_ppid(pid)
    depth = 0
    while cur and cur not in seen and depth < 8:
        seen.add(cur)
        c_comm = proc_comm(cur) or "?"
        c_cmd = read_cmdline(cur)
        ancestry.append((cur, c_comm, (c_cmd or "")[:100]))
        if c_comm in ("pitchfork", "systemd") or cur == 1:
            break
        cur = proc_ppid(cur)
        depth += 1
    return {
        "comm": proc_comm(pid) or ss_comm,
        "cmdline": cmdline,
        "argv0": argv0,
        "ancestry": ancestry,
    }


def identity_text(ident: dict) -> str:
    parts = [ident.get("comm") or "", ident.get("argv0") or "",
             ident.get("cmdline") or ""]
    parts.extend(c for _, c, _ in ident["ancestry"])
    return " ".join(parts).lower()


# ---------------------------------------------------------------------------
# Owner matching
# ---------------------------------------------------------------------------

def significant_tokens(text: str) -> set[str]:
    return {
        t for t in re.split(r"[^a-z0-9]+", text.lower())
        if len(t) >= 3
    }


def owner_matches(ident_text: str, names: list[str],
                  owners: list[str | None]) -> tuple[bool, str]:
    """Heuristic: does the resolved identity look like the registered owner?

    Matches significant tokens (>=3 chars) from the SSOT var names and the
    human-maintained `# owner:` hints against the identity text (comm,
    argv0, full cmdline, ancestor commands). Returns (matched, token).
    """
    want: set[str] = set()
    for n in names:
        want |= significant_tokens(n)
    for o in owners:
        if o:
            want |= significant_tokens(o)
    # "port" is noise in every var name; drop it so it can never match alone.
    want.discard("port")
    ident_tokens = set(re.split(r"[^a-z0-9]+", ident_text))
    for tok in sorted(want, key=len, reverse=True):
        if any(tok in it or it in tok for it in ident_tokens if len(it) >= 3):
            return True, tok
    return False, ""


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def classify(ssot: dict[int, list[dict]],
             live: dict[int, list[tuple[str, int]]],
             strict: bool = False) -> dict:
    """Pure classification. Returns the report dict (JSON-serializable)."""
    report: dict = {
        "double_booked": {},
        "squatters": [],
        "unregistered_live_ports": {},
        "dynamic_pool": {},
        "expected_but_dark": [],
        "range_violations": [],
        "aliases": [],
        "unattributed": [],
        "warnings": [],
    }

    for port in sorted(ssot):
        entries = ssot[port]
        names = [e["name"] for e in entries]
        if len(names) > 1:
            if is_alias_port(names):
                report["aliases"].append(
                    {"port": port, "names": names,
                     "note": "known intentional alias group"})
            else:
                report["double_booked"][str(port)] = [
                    {"name": e["name"], "line": e["line"]} for e in entries
                ]
        if not in_ranges(port, [SERVICE_RANGE]) and not in_ranges(
            port, LEGACY_RANGES
        ):
            report["range_violations"].append(
                {"port": port, "names": names,
                 "note": "outside mandated 25000-35000 service range"})
        if port not in live:
            report["expected_but_dark"].append(port)

    for port in sorted(live):
        holders = live[port]
        if port in ssot:
            names = [e["name"] for e in ssot[port]]
            owners = [e["owner"] for e in ssot[port]]
            for comm, pid in holders:
                ident = resolve_identity(pid, comm)
                text = identity_text(ident)
                ok, token = owner_matches(text, names, owners)
                holder_desc = (
                    f"{ident['comm']} (pid {pid})"
                    + (f" [{ident['argv0']}]" if ident["argv0"] else "")
                )
                if ok:
                    continue
                if ident["cmdline"] is None and comm in GENERIC_RUNTIMES:
                    # Genuinely unreadable: report, don't guess.
                    report["unattributed"].append(
                        {"port": port, "holder": holder_desc,
                         "registered": names,
                         "note": "generic runtime, /proc cmdline unreadable — "
                                 "needs a human to map to the SSOT entry"})
                else:
                    report["squatters"].append(
                        {"port": port, "registered": names,
                         "holder": holder_desc,
                         "cmdline": (ident["cmdline"] or "")[:160],
                         "ancestry": [
                             f"{c} (pid {p})" for p, c, _ in ident["ancestry"]
                         ]})
        elif in_ranges(port, DYNAMIC_POOLS):
            report["dynamic_pool"][str(port)] = [
                f"{c} (pid {p})" for c, p in holders
            ]
        elif port in INFRA_IGNORE:
            continue
        elif in_ranges(port, [SERVICE_RANGE]) or in_ranges(port, LEGACY_RANGES):
            report["unregistered_live_ports"][str(port)] = [
                f"{c} (pid {p})" for c, p in holders
            ]

    conflicts = bool(report["double_booked"]) or bool(report["squatters"])
    if strict and report["unregistered_live_ports"]:
        conflicts = True
    report["conflicts"] = conflicts
    return report


def exit_code(report: dict) -> int:
    return 1 if report["conflicts"] else 0


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_human(report: dict, warnings: list[str], strict: bool) -> None:
    if report["double_booked"]:
        print("DOUBLE-BOOKED (same port, 2+ unrelated SSOT names):")
        for p, entries in sorted(report["double_booked"].items(),
                                 key=lambda kv: int(kv[0])):
            names = ", ".join(f"{e['name']} (L{e['line']})" for e in entries)
            print(f"  :{p} -> {names}")
    if report["squatters"]:
        print("SQUATTERS (SSOT port held by non-owner identity):")
        for s in report["squatters"]:
            print(f"  :{s['port']} registered={','.join(s['registered'])} "
                  f"holder={s['holder']}")
            if s["cmdline"]:
                print(f"      cmdline: {s['cmdline']}")
            if s["ancestry"]:
                print(f"      ancestry: {' <- '.join(s['ancestry'])}")
    if report["unregistered_live_ports"]:
        print("LIVE BUT UNREGISTERED (in service range, not in SSOT):")
        for p, holders in sorted(report["unregistered_live_ports"].items(),
                                 key=lambda kv: int(kv[0])):
            print(f"  :{p} -> {', '.join(holders)}")
    if report["unattributed"]:
        print("UNATTRIBUTED (generic runtime, cmdline unreadable — needs human):")
        for u in report["unattributed"]:
            print(f"  :{u['port']} registered={','.join(u['registered'])} "
                  f"holder={u['holder']}")
    if report["range_violations"]:
        print("RANGE VIOLATIONS (SSOT port outside 25000-35000):")
        for r in report["range_violations"]:
            print(f"  :{r['port']} -> {','.join(r['names'])}")
    if warnings:
        print("WARNINGS:")
        for w in warnings:
            print(f"  {w}")
    if report["aliases"]:
        print(f"Alias groups OK: "
              + ", ".join(f":{a['port']}={'/'.join(a['names'])}"
                          for a in report["aliases"]))
    if report["dynamic_pool"]:
        print(f"Dynamic pool (informational): "
              f"{len(report['dynamic_pool'])} live ports in 25001-25099")
    print(f"Expected-but-dark SSOT ports: "
          f"{len(report['expected_but_dark'])} (informational)")
    if not report["conflicts"]:
        print("OK: no conflicts." + (" (strict: unregistered clean)" if strict else ""))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Audit the port SSOT against live listeners.")
    ap.add_argument("--ssot", default=str(DEFAULT_SSOT))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict", action="store_true",
                    help="treat live-but-unregistered ports as conflicts")
    args = ap.parse_args(argv)

    ssot, warnings = parse_ssot(Path(args.ssot))
    live = live_listeners()
    report = classify(ssot, live, strict=args.strict)
    report["warnings"] = warnings

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_human(report, warnings, args.strict)
    return exit_code(report)


if __name__ == "__main__":
    sys.exit(main())
