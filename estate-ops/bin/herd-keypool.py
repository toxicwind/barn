#!/usr/bin/env python3
"""Thin shim: pitchfork and mise point here. All logic is in keypool/.

Edge-case fallback chain (forward, never a rollback):
  1. Primary: import keypool.__main__ from the estate root derived from
     this file's own location.
  2. Fallback: retry via /home/toxic/estate and CWD — covers symlinked, copied,
     or relocated shim layouts without touching a stale version.
  3. Last resort: a clear, actionable error on stderr + exit 3.
     Never silently runs an old copy, never swallows the root cause.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

_SEARCH = [
    ROOT,
    os.path.expanduser("/home/toxic/estate"),
    os.getcwd(),
]

_errors = []
main = None
for _base in _SEARCH:
    if _base and _base not in sys.path:
        sys.path.insert(0, _base)
    try:
        from keypool.__main__ import main  # noqa: E402,F811
        break
    except ImportError as _e:
        _errors.append((_base, _e))

if main is None:
    sys.stderr.write(
        "herd-keypool: FATAL: cannot import keypool.__main__.main\n"
        + "".join(f"  [{b}] {e}\n" for b, e in _errors)
        + "Hint: verify /home/toxic/estate/keypool/__main__.py exists and is readable,\n"
        + "      Manual intervention required: the warden is alert-only, restores are disabled.\n"
    )
    raise SystemExit(3)

if __name__ == "__main__":
    main()
