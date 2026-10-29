"""Relay records: append-only per-relay logs + automatic archival.

A relay is a mission's durable running record (the side-chat made durable:
chat.create context_mode=fresh, name relay-<agent-name>, archived on
completion). Each relay owns:
    state/relays/<relay-id>/records.jsonl   — hash-chained, append-only
    state/relays/<relay-id>/summary.json    — written once at seal time
    state/relays/archive.jsonl              — global archival index (append-only)

Sealing is idempotent: sealing an already-sealed relay is a no-op returning
the existing summary. Archival is automatic — the Dispatcher seals a worker
or coordinator's relay the moment its result is recorded (no timers, no
sweeps needed; archive_sweep exists only as idempotent repair).
"""
import json
import os
import time

from .ledger import Ledger, utcnow


class RelayStore:
    def __init__(self, state_dir):
        self.base = os.path.join(state_dir, "relays")
        os.makedirs(self.base, exist_ok=True)
        self.archive_index = os.path.join(self.base, "archive.jsonl")

    def _dir(self, relay_id):
        # Relay ids are [a-z0-9-]; guard against path escape anyway.
        safe = "".join(c for c in relay_id if c.isalnum() or c in "-_")
        if not safe or safe != relay_id:
            raise ValueError(f"unsafe relay id {relay_id!r}")
        return os.path.join(self.base, safe)

    def create(self, relay_id, owner_id, mission_id):
        """Create a relay's record store. Idempotent for the same owner."""
        d = self._dir(relay_id)
        os.makedirs(d, exist_ok=True)
        meta_path = os.path.join(d, "meta.json")
        if not os.path.exists(meta_path):
            meta = {
                "relay_id": relay_id,
                "owner_id": owner_id,
                "mission_id": mission_id,
                "created_ts": utcnow(),
                "sealed": False,
            }
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2, sort_keys=True)
        return d

    def ledger(self, relay_id):
        return Ledger(os.path.join(self._dir(relay_id), "records.jsonl"))

    def append(self, relay_id, lane, event, **fields):
        """Append one record to the relay's own log (four-lane enforced)."""
        if not os.path.isdir(self._dir(relay_id)):
            raise KeyError(f"unknown relay {relay_id!r}")
        return self.ledger(relay_id).append(lane, event, **fields)

    def is_sealed(self, relay_id):
        try:
            with open(os.path.join(self._dir(relay_id), "meta.json"),
                      encoding="utf-8") as f:
                return bool(json.load(f).get("sealed"))
        except (OSError, ValueError):
            return False

    def seal(self, relay_id, result):
        """Archive a relay: write summary.json, mark sealed, index it.

        result: {"success": bool, "summary": str, "artifacts": [...],
                 "commits": [...]}. Idempotent.
        """
        d = self._dir(relay_id)
        if not os.path.isdir(d):
            raise KeyError(f"unknown relay {relay_id!r}")
        summary_path = os.path.join(d, "summary.json")
        if self.is_sealed(relay_id):
            with open(summary_path, encoding="utf-8") as f:
                return json.load(f)
        summary = {
            "relay_id": relay_id,
            "sealed_ts": utcnow(),
            "sealed_epoch": time.time(),
            "success": bool(result.get("success")),
            "summary": result.get("summary", ""),
            "artifacts": list(result.get("artifacts", [])),
            "commits": list(result.get("commits", [])),
        }
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2, sort_keys=True)
        meta_path = os.path.join(d, "meta.json")
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        meta["sealed"] = True
        meta["sealed_ts"] = summary["sealed_ts"]
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, sort_keys=True)
        # Global archival index, append-only.
        with open(self.archive_index, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": summary["sealed_ts"],
                "relay_id": relay_id,
                "owner_id": meta.get("owner_id"),
                "mission_id": meta.get("mission_id"),
                "success": summary["success"],
            }, sort_keys=True) + "\n")
        return summary

    def archived(self):
        """Yield archival index entries (read-only)."""
        try:
            with open(self.archive_index, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        yield json.loads(line)
        except FileNotFoundError:
            return

    def verify(self, relay_id):
        """Verify a relay's record chain. Returns (ok, count, error)."""
        return self.ledger(relay_id).verify()
