"""Fleet ID issuance: mission / coordinator / worker / relay.

Conventions (from the fleet's standing practice):
  mission:     m-<slug>-<yyyymmdd>-<seq>      e.g. m-dispatcher-20260921-001
  coordinator: c-<name>-<seq>                 e.g. c-pack-keeper-004
  worker:      w-<name>-<seq>                 e.g. w-stall-slayer-012
  relay:       relay-<agent-name>             e.g. relay-stall-slayer
               (one relay per unique agent name per standing convention;
               a re-entrant name gets relay-<name>-2, -3, ...)

Sequences are atomic across processes: each counter file is guarded by
fcntl.flock, so parallel issuers can never mint the same ID. State survives
restarts — counters live on disk, never in memory.
"""
import fcntl
import os
import re
import time

KINDS = ("mission", "coordinator", "worker", "relay")

_NAME_RE = re.compile(r"[^a-z0-9-]+")


def sanitize_name(name, max_len=40):
    """Lowercase, [a-z0-9-], collapse runs, trim dashes. Never empty."""
    s = _NAME_RE.sub("-", str(name).lower()).strip("-")
    s = re.sub(r"-{2,}", "-", s)[:max_len].strip("-")
    return s or "unnamed"


def _next_seq(counters_dir, key):
    """Atomically increment and return the counter for key (flock-guarded)."""
    os.makedirs(counters_dir, exist_ok=True)
    path = os.path.join(counters_dir, key + ".ctr")
    with open(path, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.seek(0)
            raw = f.read().strip()
            n = int(raw) + 1 if raw else 1
            f.seek(0)
            f.truncate()
            f.write(str(n))
            f.flush()
            os.fsync(f.fileno())
            return n
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def issue_id(kind, name, state_dir):
    """Mint a fresh ID of the given kind. Returns the ID string.

    Relay IDs are claimed atomically (O_CREAT|O_EXCL): a re-entrant agent
    name gets relay-<name>-2, -3, ... with no TOCTOU window.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown id kind {kind!r}; want one of {KINDS}")
    counters = os.path.join(state_dir, "counters")
    clean = sanitize_name(name)
    if kind == "mission":
        day = time.strftime("%Y%m%d", time.gmtime())
        seq = _next_seq(counters, f"mission-{day}")
        return f"m-{clean}-{day}-{seq:03d}"
    if kind == "relay":
        base = f"relay-{clean}"
        claims = os.path.join(state_dir, "relay-claims")
        os.makedirs(claims, exist_ok=True)
        candidate = base
        n = 1
        while True:
            if n > 1:
                candidate = f"{base}-{n}"
            path = os.path.join(claims, candidate)
            # O_CREAT|O_EXCL: atomic — first claimer wins, no TOCTOU.
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                os.close(fd)
                return candidate
            except FileExistsError:
                n += 1
        # unreachable
    seq = _next_seq(counters, kind)
    prefix = {"coordinator": "c", "worker": "w"}[kind]
    return f"{prefix}-{clean}-{seq:03d}"
