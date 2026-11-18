#!/usr/bin/env bash
set +e
K=$(python3 -c "import json; print(json.load(open('/home/toxic/pens/barn/products/thresher/mcp_config.json'))['api_key'])")
SID=$(curl -s -D - -o /dev/null -X POST http://127.0.0.1:25127/mcp \
  -H "content-type: application/json" -H "Authorization: Bearer $K" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"tau-docs","version":"1.0"}}}' | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
echo "session: $SID"
mcpcall() {
  curl -s -X POST http://127.0.0.1:25127/mcp -H "content-type: application/json" \
    -H "Authorization: Bearer $K" -H "mcp-session-id: $SID" -H "accept: application/json, text/event-stream" -d "$1" \
    | grep "^data:" | sed 's/^data: //'
}
echo "== docs-mcp tools =="
mcpcall '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print([t['name'] for t in d.get('result',{}).get('tools',[])][:25])
" 2>/dev/null
echo "== docs-mcp: search image generation =="
mcpcall '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"call_tool_read","arguments":{"name":"docs-mcp:search_docs","arguments":{"query":"image generation multi-provider"}}}}' | head -c 1800