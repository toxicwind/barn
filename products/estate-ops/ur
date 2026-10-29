#!/bin/bash
# ur — unshare-root wrapper. EVERY command runs inside a user+mount namespace
# mapped to root. Deliberately NO --pid and NO --net: host processes, sockets
# and routes stay fully visible so audits observe the real system.
# Prefers unprivileged unshare (sudo-root is confined away from some paths
# on awrawr-pc — verified 2026-09-16); sudo only as fallback.
# Usage: ur <command> [args...]
if unshare --map-root-user --mount --fork true 2>/dev/null; then
  exec unshare --map-root-user --mount --fork "$@"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  exec sudo -n unshare --map-root-user --mount --fork "$@"
else
  exec "$@"
fi
