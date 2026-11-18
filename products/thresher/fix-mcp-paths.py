#!/usr/bin/env python3
"""Repoint the two stale squawk-path refs in thresher mcp_config.json."""
import json
from pathlib import Path

P = Path("/home/toxic/pens/barn/products/thresher/mcp_config.json")
data = json.loads(P.read_text())
servers = data.get("servers", [])
fixed = []
for s in servers:
    args = s.get("args") or []
    if any(a == "/home/toxic/pens/ranch/squawk/mcp_server.py" for a in args):
        if s.get("name") == "squawk":
            new = "/home/toxic/pens/ranch/products/squawk/mcp_server.py"
        else:
            new = "/home/toxic/pens/ranch/products/identity-router/src/identity_router/mcp_server.py"
        s["args"] = [new if a == "/home/toxic/pens/ranch/squawk/mcp_server.py" else a for a in args]
        fixed.append((s.get("name"), new))
P.write_text(json.dumps(data, indent=2) + "\n")
print("fixed:", fixed)
# verify no stale path remains
raw = P.read_text()
print("stale_left:", raw.count("/home/toxic/pens/ranch/squawk/mcp_server.py"))