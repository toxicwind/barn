"""Append-only, hash-chained JSONL ledger with exactly-four-audit-lanes enforcement.

Every record: {"seq","ts","lane","event","prev_hash","hash", ...fields}.
The chain is tamper-evident: each record's hash covers its canonical bytes
plus the previous record's hash. GENESIS anchors the first record.

Writers only ever append. Readers (read_records, verify) never mutate.
"""
import hashlib
import json
import os
import time

from . import LANE_SET

GENESIS = "GENESIS"


class LaneViolation(ValueError):
    """Raised when a record is appended with a lane outside the canonical four."""


class ChainViolation(ValueError):
    """Raised by verify() when the hash chain or lane set is broken."""


def utcnow():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _canonical(record):
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode()


def _hash_record(record):
    return hashlib.sha256(_canonical(record)).hexdigest()


def read_records(path):
    """Yield decoded records from a ledger file. Read-only: never mutates."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    yield json.loads(line)
    except FileNotFoundError:
        return


class Ledger:
    """A single append-only ledger file."""

    def __init__(self, path):
        self.path = path
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)

    def _tail_hash(self):
        """Hash of the last record, or GENESIS when the ledger is empty.

        Reads only the tail of the file (hashes are fixed-width).
        """
        try:
            with open(self.path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                if size == 0:
                    return GENESIS, 0
                step = min(size, 4096)
                f.seek(size - step)
                tail = f.read().decode("utf-8", "replace")
        except FileNotFoundError:
            return GENESIS, 0
        lines = [l for l in tail.split("\n") if l.strip()]
        if not lines:
            return GENESIS, 0
        last = json.loads(lines[-1])
        # seq of the whole file: count lines cheaply only when small; else
        # trust the tail record's seq (chain verification replays fully).
        return last.get("hash", GENESIS), int(last.get("seq", 0))

    def append(self, lane, event, **fields):
        """Append one record. Raises LaneViolation for any lane outside the four."""
        if lane not in LANE_SET:
            raise LaneViolation(
                f"lane {lane!r} is not one of the four audit lanes "
                f"{sorted(LANE_SET)} — refusing to write"
            )
        prev_hash, last_seq = self._tail_hash()
        record = {
            "seq": last_seq + 1,
            "ts": utcnow(),
            "lane": lane,
            "event": event,
            "prev_hash": prev_hash,
        }
        record.update(fields)
        record["hash"] = _hash_record(
            {k: v for k, v in record.items() if k != "hash"}
        )
        line = json.dumps(record, sort_keys=True) + "\n"
        # O_APPEND: concurrent writers cannot interleave or overwrite.
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
        return record

    def verify(self):
        """Replay the full chain. Returns (ok, count, error).

        Checks: every lane is one of the four, prev_hash links hold,
        and each record hash recomputes. Read-only.
        """
        prev = GENESIS
        count = 0
        for rec in read_records(self.path):
            count += 1
            if rec.get("lane") not in LANE_SET:
                return False, count, ChainViolation(
                    f"seq {rec.get('seq')}: lane {rec.get('lane')!r} outside the four"
                )
            if rec.get("prev_hash") != prev:
                return False, count, ChainViolation(
                    f"seq {rec.get('seq')}: prev_hash link broken"
                )
            body = {k: v for k, v in rec.items() if k != "hash"}
            if _hash_record(body) != rec.get("hash"):
                return False, count, ChainViolation(
                    f"seq {rec.get('seq')}: hash mismatch (tampered?)"
                )
            if not isinstance(rec.get("seq"), int) or rec["seq"] != count:
                return False, count, ChainViolation(
                    f"record {count}: seq out of order ({rec.get('seq')})"
                )
            prev = rec["hash"]
        return True, count, None

    def records(self, lane=None, event=None):
        for rec in read_records(self.path):
            if lane is not None and rec.get("lane") != lane:
                continue
            if event is not None and rec.get("event") != event:
                continue
            yield rec
