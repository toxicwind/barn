"""Tests for the canonical fleet dispatcher/ledger.

Run: python3 -m unittest discover -s tests -v   (from projects/ops/dispatcher/)
Stdlib only. Each test gets a fresh temp state dir; nothing touches the repo.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                os.pardir))
from fleet_dispatch import Dispatcher, LANES, issue_id  # noqa: E402
from fleet_dispatch.admission import DuplicateAdmission, AdmissionLockStore  # noqa: E402
from fleet_dispatch.dispatcher import IllegalTransition, UnknownEntity  # noqa: E402
from fleet_dispatch.ledger import Ledger, LaneViolation  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dispatch-test-")
        self.d = Dispatcher(os.path.join(self.tmp, "state"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestIDs(Base):
    def test_uniqueness(self):
        ids = {issue_id("worker", "w", self.d.state_dir) for _ in range(200)}
        self.assertEqual(len(ids), 200)

    def test_parallel_uniqueness(self):
        out, lock = [], threading.Lock()

        def mint(n):
            for _ in range(n):
                i = issue_id("worker", "racer", self.d.state_dir)
                with lock:
                    out.append(i)

        ts = [threading.Thread(target=mint, args=(50,)) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(len(out), 400)
        self.assertEqual(len(set(out)), 400)

    def test_relay_reentrant_names(self):
        r1 = issue_id("relay", "same-name", self.d.state_dir)
        r2 = issue_id("relay", "same-name", self.d.state_dir)
        r3 = issue_id("relay", "same-name", self.d.state_dir)
        self.assertEqual(r1, "relay-same-name")
        self.assertEqual(r2, "relay-same-name-2")
        self.assertEqual(r3, "relay-same-name-3")

    def test_parallel_relay_claims_unique(self):
        out, lock = [], threading.Lock()

        def claim():
            i = issue_id("relay", "racer", self.d.state_dir)
            with lock:
                out.append(i)

        ts = [threading.Thread(target=claim) for _ in range(16)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(len(set(out)), 16)

    def test_mission_id_shape(self):
        mid = issue_id("mission", "My Mission!", self.d.state_dir)
        self.assertRegex(mid, r"^m-my-mission-\d{8}-\d{3}$")


class TestAdmission(Base):
    def test_duplicate_refused(self):
        self.d.admit_mission("m1", "coordinator", "brief one",
                             dedup_key="dup:k")
        with self.assertRaises(DuplicateAdmission):
            self.d.admit_mission("m2", "coordinator", "brief two",
                                 dedup_key="dup:k")

    def test_distinct_keys_ok(self):
        a = self.d.admit_mission("m1", "agent", "b", dedup_key="k1")
        b = self.d.admit_mission("m2", "agent", "b", dedup_key="k2")
        self.assertNotEqual(a["id"], b["id"])

    def test_parallel_duplicate_exactly_one_wins(self):
        wins, lock = [], threading.Lock()

        def attempt():
            try:
                e = self.d.admit_mission("m", "agent", "b", dedup_key="race:k")
                with lock:
                    wins.append(e["id"])
            except DuplicateAdmission:
                pass

        ts = [threading.Thread(target=attempt) for _ in range(12)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(len(wins), 1)

    def test_chris_preempts_coordinator(self):
        self.d.admit_mission("m1", "coordinator", "coord brief",
                             dedup_key="preempt:k")
        ent = self.d.admit_mission("m2", "chris-direct", "Chris says go",
                                   dedup_key="preempt:k")
        self.assertEqual(ent["origin"], "chris-direct")
        gov = [r for r in self.d.ledger.records(lane="governance")
               if r["event"] == "lock-preempted"]
        self.assertEqual(len(gov), 1)
        self.assertEqual(gov[0]["new_origin"], "chris-direct")

    def test_agent_cannot_preempt_coordinator(self):
        self.d.admit_mission("m1", "coordinator", "coord brief",
                             dedup_key="nopre:k")
        with self.assertRaises(DuplicateAdmission):
            self.d.admit_mission("m2", "agent", "agent try",
                                 dedup_key="nopre:k")

    def test_stale_lock_reclaimed(self):
        store = AdmissionLockStore(self.d.state_dir)
        store.acquire("stale:k", "w-old-001", "agent", ttl_s=3600)
        # age the heartbeat artificially
        import time
        p = store._path("stale:k")
        with open(p, encoding="utf-8") as f:
            lk = json.load(f)
        lk["heartbeat_ts"] = time.time() - 7200
        with open(p, "w", encoding="utf-8") as f:
            json.dump(lk, f)
        got = store.acquire("stale:k", "w-new-002", "agent", ttl_s=3600)
        self.assertEqual(got["holder_id"], "w-new-002")

    def test_heartbeat_and_release(self):
        ent = self.d.admit_mission("m1", "agent", "b", dedup_key="hb:k")
        self.assertTrue(self.d.heartbeat(ent["id"]))
        with self.assertRaises(UnknownEntity):
            self.d.heartbeat("w-nope-999")


class TestLedger(Base):
    def test_exactly_four_lanes_enforced(self):
        led = Ledger(os.path.join(self.tmp, "l.jsonl"))
        for lane in LANES:
            led.append(lane, "e")
        self.assertEqual(len(LANES), 4)
        for bad in ("bogus", "Dispatch", "DISPATCH", "", "audit"):
            with self.assertRaises(LaneViolation):
                led.append(bad, "e")

    def test_chain_verify_ok(self):
        led = Ledger(os.path.join(self.tmp, "l.jsonl"))
        for i in range(50):
            led.append("lifecycle", "e", i=i)
        ok, n, err = led.verify()
        self.assertTrue(ok)
        self.assertEqual(n, 50)
        self.assertIsNone(err)

    def test_tamper_detected(self):
        path = os.path.join(self.tmp, "l.jsonl")
        led = Ledger(path)
        for i in range(5):
            led.append("lifecycle", "e", i=i)
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
        rec = json.loads(lines[2])
        rec["i"] = 999
        lines[2] = json.dumps(rec, sort_keys=True) + "\n"
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(lines)
        ok, n, err = Ledger(path).verify()
        self.assertFalse(ok)
        self.assertIsNotNone(err)

    def test_readers_do_not_mutate(self):
        path = os.path.join(self.tmp, "l.jsonl")
        led = Ledger(path)
        led.append("dispatch", "e")
        before = self._read_bytes(path)
        list(led.records())
        led.verify()
        self.assertEqual(before, self._read_bytes(path))

    @staticmethod
    def _read_bytes(path):
        with open(path, "rb") as f:
            return f.read()


class TestLifecycle(Base):
    def _mission(self):
        return self.d.admit_mission("m", "coordinator", "b")

    def test_full_worker_lifecycle(self):
        m = self._mission()
        w = self.d.admit_worker("w1", m["id"], "coordinator", "do the thing")
        self.assertEqual(w["state"], "admitted")
        self.assertTrue(w["relay_id"].startswith("relay-w1"))
        self.d.transition(w["id"], "running")
        ent = self.d.record_result(
            w["id"], True, "done",
            artifacts=["projects/ops/dispatcher/README.md"],
            commits=["3a5426fe69389e4c01240f831844e80bda4af546"])
        self.assertEqual(ent["state"], "completed")
        # automatic relay archival
        self.assertTrue(self.d.relays.is_sealed(w["relay_id"]))
        summaries = list(self.d.relays.archived())
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0]["relay_id"], w["relay_id"])
        gov = [r for r in self.d.ledger.records(lane="governance")
               if r["event"] == "relay-archived"]
        self.assertEqual(len(gov), 1)

    def test_illegal_transition_rejected(self):
        m = self._mission()
        with self.assertRaises(IllegalTransition):
            self.d.transition(m["id"], "completed")  # admitted -> completed illegal
        self.d.transition(m["id"], "running")
        self.d.record_result(m["id"], False, "nope")
        with self.assertRaises(IllegalTransition):
            self.d.transition(m["id"], "running")  # terminal -> running illegal

    def test_stall_recovery(self):
        m = self._mission()
        self.d.transition(m["id"], "running")
        self.d.transition(m["id"], "stalled", note="quiet too long")
        self.d.transition(m["id"], "running", note="back")
        self.assertEqual(self.d.status(m["id"])["state"], "running")

    def test_bad_commit_rejected(self):
        m = self._mission()
        self.d.transition(m["id"], "running")
        with self.assertRaises(ValueError):
            self.d.record_result(m["id"], True, "x", commits=["not-a-sha!!"])

    def test_manifest_aggregation(self):
        m = self._mission()
        w1 = self.d.admit_worker("w1", m["id"], "coordinator", "b1")
        w2 = self.d.admit_worker("w2", m["id"], "coordinator", "b2")
        for w in (w1, w2):
            self.d.transition(w["id"], "running")
        self.d.record_result(w1["id"], True, "one",
                             artifacts=["a/1.txt"], commits=["a" * 40])
        self.d.record_result(w2["id"], True, "two",
                             artifacts=["a/2.txt"], commits=["b" * 40])
        man = self.d.mission_manifest(m["id"])
        self.assertEqual(man["all_artifacts"], ["a/1.txt", "a/2.txt"])
        self.assertEqual(man["all_commits"], ["a" * 40, "b" * 40])
        self.assertEqual(len(man["entities"]), 2)

    def test_archive_sweep_repairs_unsealed(self):
        m = self._mission()
        w = self.d.admit_worker("w1", m["id"], "coordinator", "b")
        self.d.transition(w["id"], "running")
        # simulate a crash between result and seal: write terminal state
        # directly, bypassing record_result's seal
        ent = self.d._load(w["id"])
        ent["state"] = "completed"
        ent["result"] = {"success": True, "summary": "s",
                         "artifacts": [], "commits": []}
        self.d._save(ent)
        self.assertFalse(self.d.relays.is_sealed(w["relay_id"]))
        sealed = self.d.archive_sweep()
        self.assertEqual(sealed, [w["relay_id"]])
        # idempotent
        self.assertEqual(self.d.archive_sweep(), [])

    def test_intake_hook(self):
        r = self.d.intake_submit({"from": "ember", "text": "probe herd health",
                                  "origin": "agent"})
        self.assertIsNotNone(r["admitted"])
        r2 = self.d.intake_submit({"from": "ember",
                                   "text": "probe herd health",
                                   "origin": "agent"})
        self.assertEqual(r2["rejected"], "duplicate")
        r3 = self.d.intake_submit({"from": "x", "text": "   ", "origin": "agent"})
        self.assertEqual(r3["rejected"], "empty request")


class TestRestart(Base):
    def test_continuity_across_instances(self):
        st = os.path.join(self.tmp, "state")
        d1 = Dispatcher(st)
        m = d1.admit_mission("persist", "coordinator", "b")
        w = d1.admit_worker("w1", m["id"], "coordinator", "b")
        # "restart": brand-new Dispatcher, same dir, no shared memory
        d2 = Dispatcher(st)
        self.assertEqual(d2.status(m["id"])["state"], "admitted")
        d2.transition(w["id"], "running")
        d2.record_result(w["id"], True, "after restart",
                         commits=["c" * 40])
        # ledger chain continued, not restarted
        ok, n, err = d2.ledger.verify()
        self.assertTrue(ok, err)
        self.assertGreater(n, 5)
        # counters continued: next worker id does not reuse
        w2 = d2.admit_worker("w2", m["id"], "coordinator", "b")
        self.assertNotEqual(w2["id"], w["id"])
        # locks survived the restart (mission lock still live — mission open)
        with self.assertRaises(DuplicateAdmission):
            d2.admit_mission("other", "agent", "b",
                             dedup_key=m["dedup_key"])
        # audit passes end to end
        report = d2.audit()
        self.assertTrue(report["ok"], report)


if __name__ == "__main__":
    unittest.main()
