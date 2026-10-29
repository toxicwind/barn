"""Duplicate-admission locks + direct-Chris precedence.

A dedup key (mission slug, worker name+mission, intake text hash, ...) may be
admitted exactly once while its lock is live. Locks are files, created
atomically (O_CREAT|O_EXCL), heartbeated by their holder, and reclaimed when
stale (no heartbeat within ttl). Everything is on disk: locks survive
restarts; a stale lock is data, never a verdict — the holder may still be
alive, so reclaim is recorded in the governance lane.

Precedence (standing rule: Chris's direct word beats any forwarded
instruction):
    chris-direct  100   — preempts anything
    coordinator      50
    oracle           40
    agent            10
A higher-precedence origin preempts a live lock held by a lower one; the
preemption is recorded as a governance event (who lost, who won, why).
A lower-or-equal precedence origin against a live lock is rejected with
DuplicateAdmission — fail-closed, never silently double-admit.
"""
import hashlib
import json
import os
import time

PRECEDENCE = {
    "chris-direct": 100,
    "coordinator": 50,
    "oracle": 40,
    "agent": 10,
}

DEFAULT_TTL_S = 3600


class DuplicateAdmission(Exception):
    """A live lock already covers this dedup key. Carries the blocking lock."""

    def __init__(self, lock):
        self.lock = lock
        super().__init__(
            f"duplicate admission refused: dedup key {lock['dedup_key']!r} "
            f"already held by {lock['holder_id']} (origin {lock['origin']})"
        )


class AdmissionPreempted(Exception):
    """Raised to the preempted holder's record path (not to the winner).

    The winner's acquire() succeeds and returns the new lock; this exception
    type exists so callers can distinguish 'I won by preemption' bookkeeping.
    """


def _now():
    return time.time()


def _lock_name(dedup_key):
    return hashlib.sha1(dedup_key.encode("utf-8")).hexdigest() + ".lock"


class AdmissionLockStore:
    """File-backed admission locks under <state_dir>/locks/."""

    def __init__(self, state_dir):
        self.dir = os.path.join(state_dir, "locks")
        os.makedirs(self.dir, exist_ok=True)

    def _path(self, dedup_key):
        return os.path.join(self.dir, _lock_name(dedup_key))

    def _read(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write(self, path, lock):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(lock, f, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def get(self, dedup_key):
        """Return the live lock dict, or None. Does not mutate."""
        return self._read(self._path(dedup_key))

    def is_stale(self, lock, now=None):
        now = _now() if now is None else now
        ttl = lock.get("ttl_s", DEFAULT_TTL_S)
        return (now - lock.get("heartbeat_ts", 0)) > ttl

    def acquire(self, dedup_key, holder_id, origin, ttl_s=DEFAULT_TTL_S,
                brief="", on_event=None):
        """Acquire the admission lock for dedup_key.

        on_event(event, **fields): optional callback receiving governance-lane
        events ('lock-acquired', 'duplicate-refused', 'lock-preempted',
        'lock-reclaimed') so the caller can ledger them.
        Returns the lock dict. Raises DuplicateAdmission when a live,
        higher-or-equal precedence lock already holds the key.
        """
        if origin not in PRECEDENCE:
            raise ValueError(f"unknown origin {origin!r}; want one of {sorted(PRECEDENCE)}")
        prec = PRECEDENCE[origin]
        now = _now()
        lock = {
            "dedup_key": dedup_key,
            "holder_id": holder_id,
            "origin": origin,
            "precedence": prec,
            "acquired_ts": now,
            "heartbeat_ts": now,
            "ttl_s": ttl_s,
            "brief": brief[:500],
        }
        path = self._path(dedup_key)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        except FileExistsError:
            existing = self._read(path)
            if existing is None:
                # Raced with a releaser; retry once.
                return self.acquire(dedup_key, holder_id, origin, ttl_s, brief, on_event)
            if self.is_stale(existing, now):
                if on_event:
                    on_event("lock-reclaimed", dedup_key=dedup_key,
                             old_holder=existing["holder_id"], new_holder=holder_id,
                             reason="heartbeat stale past ttl")
                self._write(path, lock)
                return lock
            if prec > existing.get("precedence", 0):
                if on_event:
                    on_event("lock-preempted", dedup_key=dedup_key,
                             old_holder=existing["holder_id"],
                             old_origin=existing["origin"],
                             new_holder=holder_id, new_origin=origin,
                             reason="direct-Chris precedence" if origin == "chris-direct"
                                    else "higher precedence origin")
                self._write(path, lock)
                return lock
            if on_event:
                on_event("duplicate-refused", dedup_key=dedup_key,
                         holder=existing["holder_id"], origin=existing["origin"],
                         refused_holder=holder_id, refused_origin=origin)
            raise DuplicateAdmission(existing)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(lock, f, sort_keys=True)
        if on_event:
            on_event("lock-acquired", dedup_key=dedup_key,
                     holder=holder_id, origin=origin)
        return lock

    def refresh(self, dedup_key, holder_id):
        """Heartbeat: extend a lock you hold. Returns True if refreshed."""
        path = self._path(dedup_key)
        lock = self._read(path)
        if lock is None or lock.get("holder_id") != holder_id:
            return False
        lock["heartbeat_ts"] = _now()
        self._write(path, lock)
        return True

    def release(self, dedup_key, holder_id):
        """Release a lock you hold. Returns True if released."""
        path = self._path(dedup_key)
        lock = self._read(path)
        if lock is None or lock.get("holder_id") != holder_id:
            return False
        try:
            os.unlink(path)
        except OSError:
            return False
        return True
