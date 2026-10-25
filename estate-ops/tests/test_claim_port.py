#!/usr/bin/env python3
"""Tests for bin/claim-port — the fail-fast pre-launch reserved-port guard.

Proves, against real sockets and the real script:
  - occupied port  -> exit 4 (REFUSED, no kill, no exec)
  - protected port -> exit 5 (bridge/squawk never touched)
  - free port      -> exit 0 (command exec'd)
  - bad usage      -> exit 2

Stdlib unittest only. Run on yote:
    python3 bin/tests/test_claim_port.py
"""
import os
import socket
import subprocess
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent
GUARD = str(BIN / "claim-port")


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def is_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    rc = s.connect_ex(("127.0.0.1", port))
    s.close()
    return rc != 0


class GuardTest(unittest.TestCase):
    def test_occupied_port_refuses_with_exit_4(self):
        # Hold the port open for the whole test: the guard must see OUR
        # process as the holder and refuse without killing it.
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        try:
            p = subprocess.run(
                [GUARD, str(port), "/bin/echo", "SHOULD-NOT-PRINT"],
                capture_output=True, text=True, timeout=15)
            self.assertEqual(p.returncode, 4, p.stderr)
            self.assertIn("REFUSING", p.stderr)
            self.assertIn("occupied", p.stderr)
            self.assertNotIn("SHOULD-NOT-PRINT", p.stdout)
            # The holder (us) survived: no kills happened.
            self.assertEqual(srv.getsockname()[1], port)
        finally:
            srv.close()

    def test_protected_ports_refuse_with_exit_5(self):
        # 25147 = live squawk-ws. The guard must refuse BEFORE any holder
        # check — it never touches squawk.
        for port in ("25147", "25135", "8379", "25204"):
            p = subprocess.run(
                [GUARD, port, "/bin/echo", "SHOULD-NOT-PRINT"],
                capture_output=True, text=True, timeout=15)
            self.assertEqual(p.returncode, 5, (port, p.stderr))
            self.assertIn("protected", p.stderr.lower())
            self.assertNotIn("SHOULD-NOT-PRINT", p.stdout)

    def test_free_port_execs_command(self):
        port = free_port()
        self.assertTrue(is_free(port))
        p = subprocess.run(
            [GUARD, str(port), "/bin/echo", "guard-ok"],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("guard-ok", p.stdout)

    def test_invalid_port_is_exit_2(self):
        p = subprocess.run(
            [GUARD, "notaport", "/bin/true"],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 2)

    def test_missing_command_is_exit_2(self):
        p = subprocess.run([GUARD, "25126"],
                           capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 2)


if __name__ == "__main__":
    unittest.main()
