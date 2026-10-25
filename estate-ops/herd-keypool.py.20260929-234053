#!/usr/bin/env python3
"""Thin shim: pitchfork and mise point here. All logic is in keypool/."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from keypool.__main__ import main  # noqa: E402

if __name__ == "__main__":
    main()
