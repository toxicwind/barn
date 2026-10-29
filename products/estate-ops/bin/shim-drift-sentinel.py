#!/usr/bin/env python3
"""shim-drift-sentinel — Raccoon task 1.
Fails loud (exit 1) when the deployed sidechat shim drifts:
  - the two canonical copies differ, or
  - the standalone self-test drops below full pass.
Event-driven friendly: run it on any shim write (inotify) or lane start;
it is a check, not a poller. Prints one verdict line."""
import hashlib, subprocess, sys
COPIES = ["/home/toxic/hatch/sidechat_shim.py",
          "/home/toxic/kite/kite/sidechat_shim.py"]
def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()
try:
    shas = [sha(p) for p in COPIES]
except OSError as e:
    print("DRIFT: copy unreadable: %s" % e); sys.exit(1)
if len(set(shas)) != 1:
    print("DRIFT: copies differ: %s" % shas); sys.exit(1)
r = subprocess.run([sys.executable, COPIES[0], "--self-test"],
                   capture_output=True, text=True)
line = [l for l in r.stdout.splitlines() if "self-test:" in l]
if not line or "55/55" not in line[-1]:
    print("DRIFT: self-test not full pass: %s" % (line[-1] if line else r.stdout[-200:])); sys.exit(1)
print("OK: shim sha %s, %s" % (shas[0][:16], line[-1].strip()))
