#!/usr/bin/env bash
set +e
K=$(python3 -c "import json; print(json.load(open('/home/toxic/pens/barn/products/thresher/mcp_config.json'))['api_key'])")
SID=$(curl -s -D - -o /tmp/mcp-init3.json -X POST http://127.0.0.1:25127/mcp \
  -H "content-type: application/json" -H "Authorization: Bearer $K" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"tau-proof","version":"1.0"}}}' | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
echo "session: $SID"
mcpcall() {
  curl -s -X POST http://127.0.0.1:25127/mcp -H "content-type: application/json" \
    -H "Authorization: Bearer $K" -H "mcp-session-id: $SID" -d "$1"
}
echo "== squawk tools via retrieve =="
mcpcall '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"retrieve_tools","arguments":{"query":"squawk chat todo board messages"}}}' | head -c 2200
echo; echo "== web surface =="
curl -s -m 5 -o /dev/null -w "root: %{http_code}\n" http://127.0.0.1:25127/
curl -s -m 5 -o /dev/null -w "api/servers: %{http_code}\n" http://127.0.0.1:25127/api/v1/servers