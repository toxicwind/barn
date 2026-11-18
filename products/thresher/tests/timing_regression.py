#!/usr/bin/env python3
"""
timing_regression.py — regression gate for thresher's tool-discovery path.

`search_servers` used to hang (or 401) when the vendored snapshot drifted
2,033 commits behind upstream. This test pins the observable behavior:

  * the endpoint answers MCP `initialize` with the configured API key
  * `tools/call search_servers` returns 200 within the budget (default 1.0s)

Exit codes: 0 = pass, 1 = fail, 77 = skipped (daemon not running).

usage:
  python3 tests/timing_regression.py [--url http://127.0.0.1:25127/mcp]
                                     [--budget 1.0] [--key KEY]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:25127/mcp"
DEFAULT_BUDGET = 1.0


def resolve_key(explicit: str | None) -> str | None:
    """API key from --key, then the environment, then the secretsmith/`.secrets` fallback."""
    if explicit:
        return explicit
    for name in ("MCPPROXY_API_KEY", "THRESHER_KEY"):
        value = os.environ.get(name)
        if value:
            return value.strip().strip("'\"")
    path = os.path.expanduser("~/.secrets")
    try:
        with open(path, encoding="utf-8") as handle:
            match = re.search(r"^MCPPROXY_API_KEY=(\S+)$", handle.read(), re.M)
    except OSError:
        return None
    if not match:
        return None
    return match.group(1).strip().strip("'\"")


def call(url: str, method: str, params: dict, key: str, session_id: str = "") -> tuple[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(url, data=payload, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.headers.get("Mcp-Session-Id", ""), response.read().decode("utf-8", "replace")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--budget", type=float, default=DEFAULT_BUDGET)
    parser.add_argument("--key", default=None)
    args = parser.parse_args()

    key = resolve_key(args.key)
    if not key:
        print("SKIP: no API key available (set MCPPROXY_API_KEY or use ~/.secrets)")
        return 77

    try:
        session_id, _ = call(
            args.url,
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "timing-regression", "version": "1"},
            },
            key,
        )
    except urllib.error.HTTPError as exc:
        print(f"FAIL: initialize -> HTTP {exc.code} ({exc.read()[:120]!r})")
        return 1
    except OSError as exc:
        print(f"SKIP: daemon not reachable at {args.url}: {exc}")
        return 77

    started = time.monotonic()
    try:
        _, body = call(
            args.url,
            "tools/call",
            {"name": "search_servers", "arguments": {"query": "github", "limit": 3}},
            key,
            session_id,
        )
    except urllib.error.HTTPError as exc:
        elapsed = time.monotonic() - started
        print(f"FAIL: search_servers -> HTTP {exc.code} after {elapsed:.3f}s")
        return 1
    except OSError as exc:
        elapsed = time.monotonic() - started
        print(f"FAIL: search_servers -> {exc} after {elapsed:.3f}s")
        return 1

    elapsed = time.monotonic() - started
    ok = elapsed <= args.budget
    print(f"{'PASS' if ok else 'FAIL'}: search_servers in {elapsed:.3f}s (budget {args.budget:.3f}s)")
    if not ok:
        return 1
    print(f"      response bytes: {len(body)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
