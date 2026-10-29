"""Dispatcher — the canonical fleet admission + lifecycle + ledger orchestrator.

One Dispatcher per state dir; many processes may share a state dir safely
(atomic locks, O_APPEND ledgers, flock counters). No in-memory state that
matters: kill the process, reboot the box, open a new Dispatcher on the
same dir and everything continues.

Lane discipline (enforced by the ledger writer):
  dispatch   — admissions, assignments, intake decisions
  lifecycle  — state transitions, results, relay seals
  artifact   — artifact + commit registrations, mission manifests
  governance — lock decisions, precedence/preemption, archival, overrides
"""
import hashlib
import json
import os

from . import LANE_SET
from .ledger import Ledger, utcnow
from .ids import issue_id, sanitize_name
from .admission import AdmissionLockStore, DuplicateAdmission, PRECEDENCE
from .relay import RelayStore

TERMINAL = ("completed", "failed", "killed")

TRANSITIONS = {
    "admitted": ("running", "killed"),
    "running": ("stalled", "completed", "failed", "killed"),
    "stalled": ("running", "failed", "killed"),
    "completed": (),
    "failed": (),
    "killed": (),
}

_KINDS_WITH_RELAY = ("coordinator", "worker")


class UnknownEntity(KeyError):
    pass


class IllegalTransition(ValueError):
    pass


class Dispatcher:
    def __init__(self, state_dir):
        self.state_dir = state_dir
        os.makedirs(state_dir, exist_ok=True)
        self.ledger = Ledger(os.path.join(state_dir, "ledger.jsonl"))
        self.locks = AdmissionLockStore(state_dir)
        self.relays = RelayStore(state_dir)
        self.entities_dir = os.path.join(state_dir, "entities")
        os.makedirs(self.entities_dir, exist_ok=True)

    # ---- entities -----------------------------------------------------
    def _entity_path(self, entity_id):
        safe = "".join(c for c in entity_id if c.isalnum() or c in "-_")
        if not safe or safe != entity_id:
            raise UnknownEntity(entity_id)
        return os.path.join(self.entities_dir, safe + ".json")

    def _load(self, entity_id):
        try:
            with open(self._entity_path(entity_id), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            raise UnknownEntity(entity_id)

    def _save(self, entity):
        tmp = self._entity_path(entity["id"]) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entity, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self._entity_path(entity["id"]))

    def _gov(self, event, **fields):
        """Emit a governance-lane lock/precedence event to the fleet ledger."""
        self.ledger.append("governance", event, **fields)

    # ---- admission ----------------------------------------------------
    def _admit(self, kind, name, origin, brief, dedup_key, mission_id=None,
               coordinator_id=None):
        if origin not in PRECEDENCE:
            raise ValueError(f"unknown origin {origin!r}")
        entity_id = issue_id(kind, name, self.state_dir)
        # Duplicate-admission lock first: fail-closed before minting anything
        # visible. The lock holder is the entity id.
        self.locks.acquire(
            dedup_key, entity_id, origin, brief=brief,
            on_event=lambda event, **kw: self._gov(event, **kw),
        )
        relay_id = None
        if kind in _KINDS_WITH_RELAY:
            relay_id = issue_id("relay", name, self.state_dir)
            self.relays.create(relay_id, owner_id=entity_id,
                               mission_id=mission_id)
        entity = {
            "id": entity_id,
            "kind": kind,
            "name": sanitize_name(name),
            "mission_id": mission_id or (entity_id if kind == "mission" else None),
            "coordinator_id": coordinator_id,
            "relay_id": relay_id,
            "origin": origin,
            "brief": brief[:2000],
            "dedup_key": dedup_key,
            "state": "admitted",
            "state_ts": utcnow(),
            "artifacts": [],
            "commits": [],
            "result": None,
        }
        self._save(entity)
        self.ledger.append(
            "dispatch", f"{kind}-admitted",
            entity_id=entity_id, name=entity["name"], origin=origin,
            mission_id=entity["mission_id"], relay_id=relay_id,
            dedup_key=dedup_key, brief=brief[:500],
        )
        return entity

    def admit_mission(self, slug, origin, brief, dedup_key=None):
        slug = sanitize_name(slug)
        return self._admit("mission", slug, origin, brief,
                           dedup_key or f"mission:{slug}")

    def admit_coordinator(self, name, mission_id, origin, brief, dedup_key=None):
        self._load(mission_id)  # fail fast on unknown mission
        return self._admit("coordinator", name, origin, brief,
                           dedup_key or f"coordinator:{mission_id}:{sanitize_name(name)}",
                           mission_id=mission_id)

    def admit_worker(self, name, mission_id, origin, brief,
                     coordinator_id=None, dedup_key=None):
        self._load(mission_id)
        if coordinator_id:
            self._load(coordinator_id)
        return self._admit("worker", name, origin, brief,
                           dedup_key or f"worker:{mission_id}:{sanitize_name(name)}",
                           mission_id=mission_id, coordinator_id=coordinator_id)

    # ---- lifecycle ----------------------------------------------------
    def transition(self, entity_id, to_state, note=""):
        entity = self._load(entity_id)
        cur = entity["state"]
        if to_state not in TRANSITIONS.get(cur, ()):
            raise IllegalTransition(
                f"{entity_id}: {cur} -> {to_state} is not a legal transition "
                f"(legal: {list(TRANSITIONS.get(cur, ())) or 'none — terminal'})"
            )
        entity["state"] = to_state
        entity["state_ts"] = utcnow()
        self._save(entity)
        self.ledger.append("lifecycle", "entity-transition",
                           entity_id=entity_id, kind=entity["kind"],
                           from_state=cur, to_state=to_state, note=note[:500])
        return entity

    def heartbeat(self, entity_id):
        """Refresh the entity's admission lock. Returns True if live."""
        entity = self._load(entity_id)
        return self.locks.refresh(entity["dedup_key"], entity_id)

    # ---- results + artifacts ------------------------------------------
    def record_result(self, entity_id, success, summary,
                      artifacts=(), commits=()):
        """Record an entity's result; terminal transition + auto relay archival.

        artifacts: iterable of artifact paths/descriptions.
        commits: iterable of commit SHAs (validated as hex, 7..64 chars).
        """
        entity = self._load(entity_id)
        if entity["state"] in TERMINAL:
            raise IllegalTransition(f"{entity_id} already terminal ({entity['state']})")
        clean_commits = []
        for sha in commits:
            s = str(sha).strip().lower()
            if not (7 <= len(s) <= 64 and all(c in "0123456789abcdef" for c in s)):
                raise ValueError(f"refusing non-SHA commit value {sha!r}")
            clean_commits.append(s)
        result = {
            "success": bool(success),
            "summary": str(summary)[:2000],
            "artifacts": [str(a) for a in artifacts],
            "commits": clean_commits,
            "recorded_ts": utcnow(),
        }
        entity["artifacts"].extend(result["artifacts"])
        entity["commits"].extend(result["commits"])
        entity["result"] = result
        to_state = "completed" if success else "failed"
        entity["state"] = to_state
        entity["state_ts"] = utcnow()
        self._save(entity)
        self.ledger.append("lifecycle", "result-recorded",
                           entity_id=entity_id, kind=entity["kind"],
                           success=bool(success), summary=result["summary"][:500],
                           n_artifacts=len(result["artifacts"]),
                           n_commits=len(result["commits"]))
        self.ledger.append("artifact", "artifacts-registered",
                           entity_id=entity_id, mission_id=entity["mission_id"],
                           artifacts=result["artifacts"], commits=result["commits"])
        # Automatic relay archival — no timers, no sweeps needed.
        if entity.get("relay_id"):
            sealed = self.relays.seal(entity["relay_id"], result)
            self.ledger.append("governance", "relay-archived",
                               relay_id=entity["relay_id"],
                               owner_id=entity_id,
                               mission_id=entity["mission_id"],
                               success=bool(success))
        # Admission served its purpose; release the lock so a future
        # same-key admission is a conscious new decision, not a collision.
        self.locks.release(entity["dedup_key"], entity_id)
        return entity

    def mission_manifest(self, mission_id):
        """Aggregate every artifact + commit across a mission's entities."""
        mission = self._load(mission_id)
        if mission["kind"] != "mission":
            raise ValueError(f"{mission_id} is not a mission")
        items = []
        for fname in sorted(os.listdir(self.entities_dir)):
            if not fname.endswith(".json"):
                continue
            with open(os.path.join(self.entities_dir, fname),
                      encoding="utf-8") as f:
                ent = json.load(f)
            if ent.get("mission_id") == mission_id and ent["id"] != mission_id:
                items.append({
                    "entity_id": ent["id"],
                    "kind": ent["kind"],
                    "name": ent["name"],
                    "state": ent["state"],
                    "success": (ent["result"] or {}).get("success"),
                    "artifacts": ent["artifacts"],
                    "commits": ent["commits"],
                })
        manifest = {
            "mission_id": mission_id,
            "mission_state": mission["state"],
            "generated_ts": utcnow(),
            "entities": items,
            "all_artifacts": sorted({a for i in items for a in i["artifacts"]}),
            "all_commits": sorted({c for i in items for c in i["commits"]}),
        }
        self.ledger.append("artifact", "mission-manifest",
                           mission_id=mission_id,
                           n_entities=len(items),
                           n_artifacts=len(manifest["all_artifacts"]),
                           n_commits=len(manifest["all_commits"]))
        return manifest

    # ---- queries ------------------------------------------------------
    def status(self, entity_id=None):
        if entity_id:
            return self._load(entity_id)
        out = []
        for fname in sorted(os.listdir(self.entities_dir)):
            if fname.endswith(".json"):
                with open(os.path.join(self.entities_dir, fname),
                          encoding="utf-8") as f:
                    out.append(json.load(f))
        return out

    def audit(self):
        """Verify the fleet ledger chain + every relay chain. Read-only."""
        ok, count, err = self.ledger.verify()
        report = {
            "ledger": {"ok": ok, "records": count,
                       "error": None if err is None else str(err)},
            "relays": {},
        }
        for fname in sorted(os.listdir(self.entities_dir)):
            if not fname.endswith(".json"):
                continue
            with open(os.path.join(self.entities_dir, fname),
                      encoding="utf-8") as f:
                ent = json.load(f)
            rid = ent.get("relay_id")
            if rid:
                rok, rcount, rerr = self.relays.verify(rid)
                report["relays"][rid] = {
                    "ok": rok, "records": rcount,
                    "sealed": self.relays.is_sealed(rid),
                    "error": None if rerr is None else str(rerr),
                }
        report["ok"] = report["ledger"]["ok"] and all(
            r["ok"] for r in report["relays"].values())
        return report

    def archive_sweep(self):
        """Idempotent repair: seal relays of terminal entities not yet sealed."""
        sealed = []
        for fname in sorted(os.listdir(self.entities_dir)):
            if not fname.endswith(".json"):
                continue
            with open(os.path.join(self.entities_dir, fname),
                      encoding="utf-8") as f:
                ent = json.load(f)
            rid = ent.get("relay_id")
            if (ent["state"] in TERMINAL and rid
                    and not self.relays.is_sealed(rid)):
                result = ent.get("result") or {"success": False,
                                               "summary": "sealed by sweep: no result recorded",
                                               "artifacts": ent["artifacts"],
                                               "commits": ent["commits"]}
                self.relays.seal(rid, result)
                self.ledger.append("governance", "relay-archived",
                                   relay_id=rid, owner_id=ent["id"],
                                   mission_id=ent["mission_id"],
                                   success=bool(result.get("success")),
                                   via="archive-sweep")
                sealed.append(rid)
        return sealed

    # ---- intake hook --------------------------------------------------
    def intake_submit(self, request):
        """Minimal intake hook for the oracle front door (lane-oracle-connector).

        request: {"from": str, "text": str, "origin": str}. Full triage stays
        in oracle-market's intake; this is the admission endpoint: non-empty
        requests become missions (deduped on text hash), empties are refused.
        """
        frm = request.get("from", "?")
        text = (request.get("text") or "").strip()
        origin = request.get("origin", "agent")
        if origin not in PRECEDENCE:
            origin = "agent"
        if not text:
            self.ledger.append("dispatch", "intake-refused",
                               from_agent=frm, reason="empty request")
            return {"admitted": None, "rejected": "empty request"}
        digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
        slug = sanitize_name(" ".join(text.split()[:6])) or "intake"
        try:
            ent = self.admit_mission(
                slug=f"intake-{slug}", origin=origin,
                brief=f"intake from {frm}: {text[:500]}",
                dedup_key=f"intake:{digest}")
        except DuplicateAdmission as e:
            self.ledger.append("dispatch", "intake-duplicate",
                               from_agent=frm,
                               existing_holder=e.lock["holder_id"])
            return {"admitted": None, "rejected": "duplicate",
                    "existing": e.lock["holder_id"]}
        return {"admitted": ent["id"], "mission_id": ent["id"]}
