#!/usr/bin/env python3
"""pitchfork-binding-sentinel -- detect + heal pitchfork tracking loss.

THE FAILURE (observed twice on 2026-10-19, estate/oracle-market):
a daemon's process is started outside the supervisor (or the
supervisor restarts and loses the child), so the supervisor's
state.toml entry decays: pid cleared, status becomes the errored
subtable, and with retry=true the supervisor spawns children that
die instantly on the singleton's lock ("another instance holds the
lock") and backs off up to an hour -- while the real service runs
healthy but UNTRACKED. `pitchfork restart` against that entry is a
no-op; status reads "errored" though the service is up. Both times
the heal was manual: stop the phantom entry, terminate the orphan,
start tracked.

This sentinel makes that heal structural, in the shim-drift
pattern: pitchfork-binding-watch.sh wakes it on every state.toml
write (inotify, no polling). Verdicts:

  OK     binding points at the live singleton process
  DOWN   no binding and no process -- genuinely stopped; the
         supervisor's own retry owns this, never healed here
  STALE  binding names a dead pid, no orphan -- the supervisor
         will reap it on its own; logged, never healed here
  DRIFT  a live process matches the daemon's signature but the
         binding does not point at it (missing/0/errored/other) --
         tracking loss. Healed automatically (allowlist only)

HEAL (detached, rate-limited per daemon): pitchfork stop <id>
(clears the retry backoff), SIGTERM the orphan(s), wait for exit,
SIGKILL survivors, pitchfork start <id>, verify the new binding
names a live pid with status running. Every step is appended to
~/.local/state/pitchfork-binding.log. A heal may only ever signal
orphans that provably HOLD the daemon's singleton lock -- a
cmdline look-alike is never enough.

Only daemons in WATCHED are ever healed -- adding one is a
deliberate, reviewed line: a cmdline signature plus the singleton
lock it holds. The oracle-market entry is the proven repeat
victim; its loop is replay-safe by design, so a heal restart loses
nothing.
"""
import json
import os
import signal
import subprocess
import sys
import time
import tomllib
from pathlib import Path

STATE_TOML = Path(os.environ.get(
    "PITCHFORK_STATE",
    Path.home() / ".local/state/pitchfork/state.toml"))
HEAL_STATE = Path(os.environ.get(
    "PITCHFORK_BINDING_HEAL_STATE",
    Path.home() / ".local/state/pitchfork-binding-heal.json"))
LOG = Path(os.environ.get(
    "PITCHFORK_BINDING_LOG",
    Path.home() / ".local/state/pitchfork-binding.log"))
HEAL_MIN_INTERVAL_S = 1800
TERM_WAIT_S = int(os.environ.get("PFB_TERM_WAIT_S", "300"))

WATCHED = {
    "estate/oracle-market": {
        "signature": "oracle_loop.py",
        "lock": "/home/toxic/estate/ranch/squawk/oracle/oracle.lock",
    },
}
# Test-only override: a fabricated WATCHED map (JSON) so a test can
# never aim the healer at a production daemon by accident. The first
# heal test (2026-10-20) SIGTERM'd the real market loop because the
# fake state's signature matched it; the lock-holder gate below is
# the structural half of that lesson, this override is the other.
if os.environ.get("PFB_WATCHED_JSON"):
    try:
        WATCHED = json.loads(os.environ["PFB_WATCHED_JSON"])
    except Exception:
        pass


def log_line(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), msg)
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass
    print(line, flush=True)


def load_state():
    with open(STATE_TOML, "rb") as f:
        return tomllib.load(f)


def signature_pids(signature):
    """Live pids whose cmdline contains the signature (excl. self)."""
    me = os.getpid()
    out = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == me:
            continue
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode("utf-8",
                                                           "replace")
        except OSError:
            continue
        if signature in cmd:
            out.append(pid)
    return out


def lock_holders(lock_path):
    """Live pids holding an advisory lock ON the lockfile, from
    /proc/locks (an open fd is NOT a lock -- the first heal test's
    dummy merely opened the file and was misread as its holder).
    Matched by inode: the device field in /proc/locks does not
    agree with stat's major:minor on this box's overlay mounts
    (observed 00:21 vs 00:23 for the same file), while the inode is
    exact. The result is always intersected with the cmdline-
    signature orphans before anything is signaled."""
    try:
        want_ino = os.stat(lock_path).st_ino
    except OSError:
        return []
    out = []
    try:
        with open("/proc/locks") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    for line in lines:
        parts = line.split()
        # "155: FLOCK  ADVISORY  WRITE 1795735 00:21:186246069 0 EOF"
        if len(parts) < 6 or parts[1] not in ("FLOCK", "POSIX"):
            continue
        try:
            ino = int(parts[5].rsplit(":", 1)[1])
            pid = int(parts[4])
        except (ValueError, IndexError):
            continue
        if ino == want_ino:
            out.append(pid)
    return out


def check(did, cfg, state):
    """Return (verdict, detail) for one watched daemon."""
    rec = (state.get("daemons") or {}).get(did)
    if rec is None:
        return "ABSENT", {"daemon": did}
    status = rec.get("status")
    status_s = status if isinstance(status, str) else json.dumps(status)
    pid = rec.get("pid") or 0
    sig_pids = signature_pids(cfg["signature"])
    if status == "running" and pid in sig_pids:
        return "OK", {"daemon": did, "pid": pid}
    orphans = [p for p in sig_pids if p != pid]
    detail = {"daemon": did, "status": status_s, "bound_pid": pid,
              "signature_pids": sig_pids}
    if orphans:
        detail["orphans"] = orphans
        holders = lock_holders(cfg["lock"]) if cfg.get("lock") else []
        detail["lock_holders"] = holders
        # Healable orphans are ONLY the ones holding the singleton
        # lock: cmdline resemblance alone never earns a SIGTERM.
        # (2026-10-20, learned by hurting the market once in a test.)
        detail["healable"] = [p for p in orphans if p in holders] \
            if cfg.get("lock") else list(orphans)
        return "DRIFT", detail
    if not sig_pids:
        if status == "running":
            return "STALE", detail
        return "DOWN", detail
    return "OK", detail


def _heal_gate(did):
    """Rate limit: at most one heal per daemon per interval."""
    try:
        data = json.loads(HEAL_STATE.read_text())
    except Exception:
        data = {}
    last = data.get(did, 0)
    now = time.time()
    if now - last < HEAL_MIN_INTERVAL_S:
        return False, int(HEAL_MIN_INTERVAL_S - (now - last))
    data[did] = now
    try:
        HEAL_STATE.write_text(json.dumps(data))
    except OSError:
        pass
    return True, 0


def _is_dead(pid):
    """Gone from /proc, or a zombie (dead, merely unreaped -- a
    zombie holds no lock and runs no code, so for heal purposes it
    is dead; the first heal test spun the full deadline on one)."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            # state is the first field after the (parenthesised) comm
            state = f.read().rsplit(b")", 1)[1].split()[0]
        return state == b"Z"
    except OSError:
        return True


def _wait_dead(pid, deadline_s):
    end = time.time() + deadline_s
    while time.time() < end:
        if _is_dead(pid):
            return True
        time.sleep(2)
    return _is_dead(pid)


def heal(did, cfg):
    """The manual Oct-19 heal, automated. Runs detached."""
    ok, wait_s = _heal_gate(did)
    if not ok:
        log_line("HEAL-SKIPPED %s rate-limited (%ds left)" % (did, wait_s))
        return 0
    state = load_state()
    verdict, detail = check(did, cfg, state)
    if verdict != "DRIFT":
        log_line("HEAL-ABORT %s verdict now %s" % (did, verdict))
        return 0
    orphans = detail.get("healable") or []
    if not orphans:
        # Signature-matching processes exist but none provably holds
        # the singleton lock -- not enough evidence to kill anything.
        log_line("HEAL-ABORT %s drift without a lock-holding orphan "
                 "(orphans=%s holders=%s)"
                 % (did, detail.get("orphans"), detail.get("lock_holders")))
        return 0
    if detail["bound_pid"] in (detail.get("lock_holders") or []):
        log_line("HEAL-ABORT %s bound pid holds the lock; state is "
                 "mid-transition, not lost" % did)
        return 0
    log_line("HEAL-START %s orphans=%s bound_pid=%s status=%s"
             % (did, orphans, detail["bound_pid"], detail["status"]))
    subprocess.run(["pitchfork", "stop", did],
                   capture_output=True, text=True)
    log_line("HEAL %s phantom entry stopped" % did)
    for pid in orphans:
        try:
            os.kill(pid, signal.SIGTERM)
            log_line("HEAL %s SIGTERM orphan %d" % (did, pid))
        except OSError as e:
            log_line("HEAL %s SIGTERM orphan %d failed: %s" % (did, pid, e))
    for pid in orphans:
        if not _wait_dead(pid, TERM_WAIT_S):
            try:
                os.kill(pid, signal.SIGKILL)
                log_line("HEAL %s SIGKILL orphan %d (SIGTERM deadline)"
                         % (did, pid))
            except OSError:
                pass
            _wait_dead(pid, 30)
    r = subprocess.run(["pitchfork", "start", did],
                       capture_output=True, text=True)
    log_line("HEAL %s pitchfork start rc=%d %s"
             % (did, r.returncode, (r.stderr or "").strip()[:120]))
    time.sleep(6)
    try:
        state2 = load_state()
        verdict2, detail2 = check(did, cfg, state2)
    except Exception as e:
        verdict2, detail2 = "UNKNOWN", {"error": str(e)[:120]}
    if verdict2 == "OK":
        log_line("HEALED %s binding now pid=%s" % (did, detail2.get("pid")))
    else:
        log_line("HEAL-FAILED %s post-heal verdict %s %s"
                 % (did, verdict2, json.dumps(detail2)[:200]))
    return 0


def main(argv):
    if len(argv) >= 3 and argv[1] == "--heal":
        did = argv[2]
        cfg = WATCHED.get(did)
        if cfg is None:
            log_line("HEAL-REFUSED %s not in allowlist" % did)
            return 2
        return heal(did, cfg)
    auto = "--auto" in argv
    try:
        state = load_state()
    except Exception as e:
        print("pitchfork-binding: state unreadable: %s" % e)
        return 1
    for did, cfg in WATCHED.items():
        verdict, detail = check(did, cfg, state)
        line = "%s %s" % (verdict, json.dumps(detail))
        if verdict == "DRIFT":
            log_line(line)
            if auto:
                subprocess.Popen(
                    [sys.executable, os.path.abspath(__file__),
                     "--heal", did],
                    start_new_session=True,
                    stdout=open(LOG, "a"), stderr=subprocess.STDOUT)
                log_line("HEAL-SPAWNED %s" % did)
        else:
            print(line, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
