#!/usr/bin/env python3
"""Tests for bin/port-audit.py — the hardened SSOT-vs-live port auditor.

Stdlib unittest only (no deps). Run on yote:
    python3 bin/tests/test_port_audit.py
or: python3 -m unittest discover -s bin/tests
"""
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "port_audit", BIN / "port-audit.py")
pa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pa)

FIXTURE_SSOT = """\
# fixture SSOT
LLAMA_SWAP_PORT=25100
HERD_PORT=25100
QDRANT_PORT=25133
QDRANT_HTTP_PORT=25133  # owner: qdrant (single http listener)
NULL_G_PROXY_PORT=25107
NULL_G_PORT=25107  # deprecated alias (forward-only)
SQUAWK_FEED_PORT=25135  # owner: squawk_feed.py (pitchfork daemons.squawk-feed)
KIMI_CODE_PORT=25126  # owner: kimi-code (must FAIL FAST not walk)
DOUBLE_A_PORT=25250
DOUBLE_B_PORT=25250
DARK_PORT=25251
FLEET_POWER_INTERVAL=5000
BAD_PORT=notaport
"""


def write_ssot(tmp):
    p = Path(tmp) / "ports.env"
    p.write_text(FIXTURE_SSOT)
    return p


def make_fake_proc(tmp):
    """Build a fixture /proc tree. Returns root path."""
    root = Path(tmp) / "proc"
    procs = {
        100: ("python3",
              b"python3\x00/home/x/squawk_feed.py\x00",
              50),
        50: ("pitchfork",
             b"/home/toxic/.local/share/mise/installs/pitchfork/pitchfork\x00supervisor\x00run\x00--boot\x00",
             1),
        200: ("kimi-code",
              b"/home/toxic/projects/kimi-code/dist/main.mjs\x00web\x00--port\x0025126\x00",
              50),
        300: ("evil-miner",
              b"/tmp/evil-miner\x00--donate-level\x001\x00",
              1),
        # 400: no cmdline file at all -> unreadable
    }
    for pid, (comm, cmdline, ppid) in procs.items():
        d = root / str(pid)
        d.mkdir(parents=True)
        (d / "comm").write_text(comm + "\n")
        (d / "cmdline").write_bytes(cmdline)
        (d / "stat").write_text(
            f"{pid} ({comm}) S {ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 0\n")
    d = root / "400"
    d.mkdir(parents=True)
    (d / "comm").write_text("python3\n")
    (d / "stat").write_text("400 (python3) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 0\n")
    return str(root)


class ParseTest(unittest.TestCase):
    def test_owner_hints_and_port_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            ssot, warnings = pa.parse_ssot(write_ssot(tmp))
        # FLEET_POWER_INTERVAL is not a port var -> excluded
        ports = set(ssot)
        self.assertNotIn(5000, ports)
        self.assertIn(25135, ssot)
        owners = {e["name"]: e["owner"] for e in ssot[25135]}
        self.assertIn("squawk_feed.py", owners["SQUAWK_FEED_PORT"])
        # non-numeric value -> warning, not crash
        self.assertTrue(any("BAD_PORT" in w for w in warnings))

    def test_alias_groups_not_double_booked(self):
        with tempfile.TemporaryDirectory() as tmp:
            ssot, _ = pa.parse_ssot(write_ssot(tmp))
        live = {}
        report = pa.classify(ssot, live)
        self.assertNotIn("25100", report["double_booked"])
        self.assertNotIn("25133", report["double_booked"])
        self.assertNotIn("25107", report["double_booked"])
        alias_ports = {a["port"] for a in report["aliases"]}
        self.assertEqual(alias_ports, {25100, 25133, 25107})

    def test_genuine_double_book_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            ssot, _ = pa.parse_ssot(write_ssot(tmp))
        report = pa.classify(ssot, {})
        self.assertIn("25250", report["double_booked"])
        self.assertTrue(report["conflicts"])
        self.assertEqual(pa.exit_code(report), 1)


class IdentityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = make_fake_proc(self.tmp.name)
        self._old = pa.PROC_ROOT
        pa.PROC_ROOT = self.fake

    def tearDown(self):
        pa.PROC_ROOT = self._old
        self.tmp.cleanup()

    def test_resolve_cmdline_and_ancestry(self):
        ident = pa.resolve_identity(100, "python3")
        self.assertIn("squawk_feed.py", ident["cmdline"])
        # argv0 is the interpreter here (python3 script.py) — the script
        # name still shows up via the full cmdline in identity_text().
        self.assertEqual(ident["argv0"], "python3")
        self.assertIn("squawk_feed.py", pa.identity_text(ident))
        # ancestry reaches the pitchfork supervisor
        comms = [c for _, c, _ in ident["ancestry"]]
        self.assertIn("pitchfork", comms)

    def test_unreadable_cmdline(self):
        ident = pa.resolve_identity(400, "python3")
        self.assertIsNone(ident["cmdline"])
        # comm falls back to the ss-provided name
        self.assertEqual(ident["comm"], "python3")


class MatchTest(unittest.TestCase):
    def test_owner_hint_matches(self):
        ok, tok = pa.owner_matches(
            "python3 squawk_feed.py /home/x/squawk_feed.py pitchfork",
            ["SQUAWK_FEED_PORT"], ["squawk_feed.py (pitchfork daemons.squawk-feed)"])
        self.assertTrue(ok)
        # any of the significant hint/var tokens is a legitimate match,
        # including the supervisor attribution from the ancestry
        self.assertIn(tok, ("squawk", "feed", "pitchfork", "daemons"))

    def test_var_name_matches_cmdline(self):
        ok, _ = pa.owner_matches(
            "kimi-code main.mjs /home/toxic/projects/kimi-code/dist/main.mjs web --port 25126",
            ["KIMI_CODE_PORT"], ["kimi-code (must FAIL FAST not walk)"])
        self.assertTrue(ok)

    def test_no_match(self):
        ok, _ = pa.owner_matches(
            "evil-miner /tmp/evil-miner --donate-level 1",
            ["SQUAWK_FEED_PORT"], ["squawk_feed.py"])
        self.assertFalse(ok)

    def test_port_token_is_noise(self):
        # "port" alone must never match
        ok, _ = pa.owner_matches("some port thing", ["FOO_PORT"], [None])
        self.assertFalse(ok)


class ClassifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = make_fake_proc(self.tmp.name)
        self._old = pa.PROC_ROOT
        pa.PROC_ROOT = self.fake
        self.ssot, _ = pa.parse_ssot(write_ssot(self.tmp.name))
        # The fixture's intentional double-book (25250) would taint every
        # "clean" assertion below; drop it here (it has its own test).
        self.ssot = {p: v for p, v in self.ssot.items() if p != 25250}

    def tearDown(self):
        pa.PROC_ROOT = self._old
        self.tmp.cleanup()

    def test_generic_runtime_with_matching_cmdline_is_ok(self):
        # python3 running squawk_feed.py on the squawk-feed port: not a squatter
        live = {25135: [("python3", 100)]}
        report = pa.classify(self.ssot, live)
        self.assertEqual(report["squatters"], [])
        self.assertFalse(report["conflicts"])

    def test_wrong_identity_is_squatter(self):
        # evil-miner on the kimi-code port
        live = {25126: [("evil-miner", 300)]}
        report = pa.classify(self.ssot, live)
        self.assertEqual(len(report["squatters"]), 1)
        self.assertEqual(report["squatters"][0]["port"], 25126)
        self.assertTrue(report["conflicts"])
        self.assertEqual(pa.exit_code(report), 1)

    def test_unreadable_generic_is_unattributed_not_squatter(self):
        live = {25135: [("python3", 400)]}
        report = pa.classify(self.ssot, live)
        self.assertEqual(report["squatters"], [])
        self.assertEqual(len(report["unattributed"]), 1)
        self.assertFalse(report["conflicts"])  # needs a human, not an error

    def test_dynamic_pool_is_informational(self):
        live = {25050: [("llama-server", 999)]}
        report = pa.classify(self.ssot, live)
        self.assertIn("25050", report["dynamic_pool"])
        self.assertNotIn("25050", report["unregistered_live_ports"])
        self.assertFalse(report["conflicts"])

    def test_unregistered_warning_and_strict(self):
        live = {25260: [("mystery", 999)]}
        report = pa.classify(self.ssot, live, strict=False)
        self.assertIn("25260", report["unregistered_live_ports"])
        self.assertFalse(report["conflicts"])
        self.assertEqual(pa.exit_code(report), 0)
        strict_report = pa.classify(self.ssot, live, strict=True)
        self.assertTrue(strict_report["conflicts"])
        self.assertEqual(pa.exit_code(strict_report), 1)

    def test_dark_ports_informational(self):
        report = pa.classify(self.ssot, {})
        self.assertIn(25251, report["expected_but_dark"])
        # dark ports are informational: no conflict, exit 0
        self.assertFalse(report["conflicts"])
        self.assertEqual(pa.exit_code(report), 0)

    def test_clean_run_exits_zero(self):
        live = {25135: [("python3", 100)],
                25126: [("kimi-code", 200)],
                25050: [("llama-server", 999)]}
        # drop the fixture double-book for a clean run
        ssot = {p: v for p, v in self.ssot.items() if p != 25250}
        report = pa.classify(ssot, live)
        self.assertFalse(report["conflicts"])
        self.assertEqual(pa.exit_code(report), 0)


if __name__ == "__main__":
    unittest.main()
