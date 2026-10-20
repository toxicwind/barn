#!/usr/bin/env bash
# Direct build entry: mise owns the toolchain; mbx-cache restores eligible task outputs.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BUILD_CMD=$(cat <<'BUILD'
set -euo pipefail
cd gatehouse && go build ./... && cd ..
cd secretsmith && /usr/bin/python3 -m unittest discover -s tests && cd ..
/usr/bin/python3 -m py_compile gemini-mcp/server.py
/usr/bin/python3 -c "import tomllib; tomllib.load(open('lookout/pitchfork.fragment.toml','rb'))"
node --check chute/chute.mjs
echo "barn build OK"
BUILD
)
exec "$ROOT/scripts/mise-build.sh" "barn" "$ROOT/barn" "$BUILD_CMD"
