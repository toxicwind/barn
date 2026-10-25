#!/usr/bin/env bash
# fleet-health.sh — one-shot fleet channel health audit.
#
# Reads the squawk fleet channel on yote and flags:
#   1. stuck/silent/dead agents — "agent joined:" announced but never reported back
#   2. erroring loops — repeated identical/similar error text from one sender
#   3. watchdog template-spam — identical alert templates posted repeatedly
#
# Exit: 0 when clean, 1 when findings. Human-readable summary to stdout.
# The one-time health pass is just the first run of this script.
#
# Usage: fleet-health.sh [--channel fleet] [--hours 24] [--new-agent-grace-m 60]
#
# Runs on yote (needs the squawk-root channel dir). Lightweight: pure reads.

set -u
CHANNEL="fleet"
HOURS=24
GRACE_M=60

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2;;
    --hours) HOURS="$2"; shift 2;;
    --new-agent-grace-m) GRACE_M="$2"; shift 2;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

# Resolve the squawk root the way the fleet server does (symlink-tolerant).
ROOT="$(readlink -f "${SQUAWK_ROOT:-/home/toxic/.fleet-bus/squawk-root}" 2>/dev/null || echo /home/toxic/.fleet-bus/squawk-root)"
CHDIR="$ROOT/$CHANNEL"
if [ ! -d "$CHDIR" ]; then
  echo "FLEET-HEALTH: channel dir not found: $CHDIR" >&2
  exit 2
fi

export FLEET_HEALTH_CHANNEL="$CHANNEL"
export FLEET_HEALTH_CHDIR="$CHDIR"
export FLEET_HEALTH_HOURS="$HOURS"
export FLEET_HEALTH_GRACE_M="$GRACE_M"

python3 - <<'PYEOF'
import os, re, sys, time
from datetime import datetime, timezone
from pathlib import Path

CHDIR = Path(os.environ["FLEET_HEALTH_CHDIR"])
HOURS = float(os.environ["FLEET_HEALTH_HOURS"])
GRACE = float(os.environ["FLEET_HEALTH_GRACE_M"]) * 60
NOW = time.time()
CUTOFF = NOW - HOURS * 3600

def parse_ts(ts):
    try:
        # handles "2026-09-20T15:16:41.281438-06:00" and "-0600" forms
        t = ts.strip().replace("Z", "+00:00")
        if re.search(r"[+-]\d{4}$", t):
            t = t[:-2] + ":" + t[-2:]
        return datetime.fromisoformat(t).timestamp()
    except Exception:
        return 0

def parse_frontmatter(path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}, ""
    meta, body = {}, text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip('"').strip("'")
            body = parts[2]
    return meta, body.strip()

msgs = []
for f in sorted(CHDIR.glob("*.md")):
    meta, body = parse_frontmatter(f)
    if not meta:
        continue
    ts = parse_ts(meta.get("ts", ""))
    if not ts or ts < CUTOFF:
        continue
    try:
        seq = int(meta.get("seq", f.stem.split("-")[0]))
    except ValueError:
        seq = 0
    msgs.append({"seq": seq, "from": meta.get("from", "?"),
                 "human": meta.get("human", ""),
                 "ts": ts, "body": body, "file": f.name})
msgs.sort(key=lambda m: (m["ts"], m["seq"]))

findings = []   # (section, summary, detail)
notes = []

def norm_template(text):
    # collapse numbers, hex ids, quoted ids, durations -> placeholders
    t = re.sub(r"`[^`]*`", "`X`", text)
    t = re.sub(r"\b[0-9a-f]{8,}\b", "N", t)
    t = re.sub(r"\d+", "N", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:220]

# ---------------------------------------------------------------- 1. stuck/silent agents
joins = {}  # name -> (ts, seq)
for m in msgs:
    for mm in re.finditer(r"agent joined:\s*([A-Za-z0-9_][A-Za-z0-9_.~-]*)", m["body"]):
        name = mm.group(1).rstrip(".-~")
        joins.setdefault(name, (m["ts"], m["seq"]))
    # also "agent joined" announcements in titles get caught via body anyway

silent, reported = [], []
for name, (jts, jseq) in sorted(joins.items(), key=lambda kv: kv[1][0]):
    follow = [m for m in msgs
              if m["seq"] > jseq and
              (m["from"] == name or name.lower() in m["body"].lower())]
    age_h = (NOW - jts) / 3600
    if not follow and age_h * 3600 > GRACE:
        silent.append((name, age_h, jseq))
        findings.append(("SILENT-AGENT",
            f"{name}: joined {age_h:.1f}h ago (seq {jseq}), no follow-up in fleet",
            "announced 'agent joined' but never reported back or got mentioned"))
    elif follow:
        reported.append(name)

# ---------------------------------------------------------------- 2. erroring loops
# Relayed messages are attributed to their true author: the "@user" in the
# "[relayed #chan by @user]" envelope line, else the frontmatter "human:".
# The envelope line and any JSON blobs are stripped before error matching —
# machine fields like "timeout_ms" or "error":"" in market JSON are routine
# traffic, not error reports.
RELAY_HDR_RE = re.compile(r"^\[relayed #\S+ by @(\S+)\]\s*", re.M)
def true_src(m):
    if m["from"] == "relay":
        mm = RELAY_HDR_RE.search(m["body"])
        if mm:
            return mm.group(1).rstrip("]")
        if m["human"]:
            return m["human"]
    return m["from"]
def err_scan_text(m):
    t = RELAY_HDR_RE.sub("", m["body"])
    prev = None
    while prev != t:      # strip nested JSON objects
        prev = t
        t = re.sub(r"\{[^{}]*\}", " ", t)
    return t
for m in msgs:
    m["src"] = true_src(m)

ERR_RE = re.compile(r"traceback|error\b|failed|exception|refused|timeout|died|crash|panic", re.I)
by_sender_firstline = {}
for m in msgs:
    scan = err_scan_text(m)
    if not ERR_RE.search(scan[:2000]):
        continue
    lines = [l for l in scan.splitlines() if l.strip()]
    first = norm_template(lines[0] if lines else "")
    key = (m["src"], first)
    by_sender_firstline.setdefault(key, []).append(m)
for (sender, first), group in sorted(by_sender_firstline.items(), key=lambda kv: -len(kv[1])):
    if len(group) >= 4:
        findings.append(("ERROR-LOOP",
            f"{sender}: {len(group)} similar error posts in {HOURS:g}h",
            f"first line: {first[:160]} (seqs {group[0]['seq']}..{group[-1]['seq']})"))

# generic repeat loop: same sender, same normalized opening, high volume.
# Routine market-engine traffic (oracle settles/assigns all day) is normal
# operation, not a loop — exclude it. Hearth posts are excluded here too:
# they get their own dedicated WATCHDOG-SPAM section below, so listing
# them twice is noise.
ROUTINE_RE = re.compile(
    r"^(oracle:|auction |intake:|bidder-\S+ (bids|bid)|"
    r"\[relayed #\S*market)", re.I)
def is_hearth(m):
    return (m["from"] in ("hearth",) or
            (m["from"] == "ember" and
             ("Hearth" in m["body"][:80] or "🐺" in m["body"][:20])))
by_open = {}
for m in msgs:
    if ROUTINE_RE.search(m["body"][:80]):
        continue
    if is_hearth(m):
        continue
    opening = norm_template(" ".join(m["body"].split()[:14]))
    key = (m["from"], opening)
    by_open.setdefault(key, []).append(m)
for (sender, opening), group in sorted(by_open.items(), key=lambda kv: -len(kv[1])):
    if len(group) >= 8 and not any(f[0] == "ERROR-LOOP" for f in findings if sender in f[1]):
        findings.append(("REPEAT-LOOP",
            f"{sender}: {len(group)} near-identical posts in {HOURS:g}h",
            f"opening: {opening[:160]} (seqs {group[0]['seq']}..{group[-1]['seq']})"))

# ---------------------------------------------------------------- 3. watchdog template-spam
hearthish = [m for m in msgs if is_hearth(m)]
tmpl = {}
for m in hearthish:
    t = norm_template(m["body"])
    tmpl.setdefault(t, []).append(m)
for t, group in sorted(tmpl.items(), key=lambda kv: -len(kv[1])):
    if len(group) >= 4:
        # classify the known noisy templates
        kind = "template"
        b0 = group[0]["body"]
        if "welcome to the den" in b0: kind = "welcome-template"
        elif "has been quiet" in b0 or "looking lonely" in b0: kind = "quiet/market-template"
        elif "checking in" in b0: kind = "pulse-template"
        findings.append(("WATCHDOG-SPAM",
            f"Hearth {kind}: {len(group)} identical posts in {HOURS:g}h",
            f"template: {t[:180]} (seqs {group[0]['seq']}..{group[-1]['seq']})"))

# ---------------------------------------------------------------- summary output
total = len(msgs)
senders = {}
for m in msgs:
    senders[m["from"]] = senders.get(m["from"], 0) + 1

print(f"fleet-health: channel={os.environ['FLEET_HEALTH_CHANNEL']} "
      f"window={HOURS:g}h messages={total} joins={len(joins)} "
      f"reported-back={len(reported)}")
top = sorted(senders.items(), key=lambda kv: -kv[1])[:6]
print("top talkers: " + ", ".join(f"{s}({n})" for s, n in top))

sections = {}
for sec, summ, det in findings:
    sections.setdefault(sec, []).append((summ, det))

if not findings:
    print("OK: no findings — fleet looks healthy.")
    sys.exit(0)

for sec in ["SILENT-AGENT", "ERROR-LOOP", "REPEAT-LOOP", "WATCHDOG-SPAM"]:
    items = sections.get(sec, [])
    if not items:
        continue
    print(f"\n== {sec} ({len(items)}) ==")
    for summ, det in items:
        print(f"  ! {summ}\n    {det}")
print(f"\nFLEET-HEALTH: {len(findings)} finding(s).")
sys.exit(1)
PYEOF
PYEOF_RC=$?
exit $PYEOF_RC
