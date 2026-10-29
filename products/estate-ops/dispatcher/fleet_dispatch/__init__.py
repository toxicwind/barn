"""fleet_dispatch — canonical dispatcher/ledger for Chris's agent fleet.

Mission/coordinator/worker/relay ID issuance, lifecycle + result tracking,
duplicate-admission locks, direct-Chris precedence, append-only hash-chained
relay records, artifact/commit aggregation, automatic relay archival, and
exactly-four-audit-lanes enforcement.

Everything is file-based (JSONL + lock files) under a state dir so it
survives process restarts and full box reboots with zero in-memory state.
No daemons, no timers: the CLI is invoked on events (admission, transition,
completion); heartbeats are caller-driven.

Canonical home: projects/ops/dispatcher/ in toxicwind/estate-scripts-projects.
"""
__version__ = "1.0.0"

# Exactly four audit lanes. Defined BEFORE the submodule imports below —
# ledger.py reads LANE_SET at its own import time, so this must come first.
# The ledger writer enforces this set fail-closed: any append with another
# lane raises LaneViolation. See README.md.
LANES = ("dispatch", "lifecycle", "artifact", "governance")
LANE_SET = frozenset(LANES)

from .ledger import Ledger, LaneViolation, ChainViolation, read_records
from .ids import issue_id, sanitize_name
from .admission import (
    AdmissionLockStore,
    DuplicateAdmission,
    AdmissionPreempted,
    PRECEDENCE,
)
from .relay import RelayStore
from .dispatcher import Dispatcher

__all__ = [
    "Ledger", "LaneViolation", "ChainViolation", "read_records",
    "issue_id", "sanitize_name",
    "AdmissionLockStore", "DuplicateAdmission", "AdmissionPreempted",
    "PRECEDENCE",
    "RelayStore", "Dispatcher",
    "LANES", "LANE_SET", "__version__",
]
