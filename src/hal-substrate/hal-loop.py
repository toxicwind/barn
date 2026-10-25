#!/usr/bin/env python3
# Compat shim 2026-09-14: hal-substrate was renamed to coyote.
# The pitchfork supervisor still references this legacy path until its config is reloaded.
# Exec the real loop so restarts keep working.
import os, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
_NEW = os.path.join(os.path.dirname(_HERE), "coyote", "coyote-loop.py")
os.execv(sys.executable, [sys.executable, _NEW] + sys.argv[1:])
