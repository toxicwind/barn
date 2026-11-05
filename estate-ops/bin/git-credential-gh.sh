#!/usr/bin/env bash
# git-credential-gh.sh — permanent GitHub credential helper for the estate.
#
# WHY THIS EXISTS (anomaly #84, fixed 2026-11-04):
#   The stock `gh auth git-credential` helper emits username=x-access-token,
#   which GitHub REJECTS for fine-grained PATs (github_pat_*). Fine-grained
#   PATs require the TOKEN ITSELF as the git username. This helper reads the
#   token from the secretsmith keyring (the single source of truth, SSOT) and
#   emits it in the format git will accept, so pushes never fail on auth.
#
#   It also protects against the "two truths" trap: only the keyring GH_TOKEN
#   is trusted. A stale GH_TOKEN env var (dead/rotated token) is IGNORED.
#
# Wire it globally:
#   git config --global credential.helper "!f() { $0 \"\$@\"; }; f"
#   (or the absolute path: git config --global credential.helper "!/home/toxic/pens/barn/estate-ops/bin/git-credential-gh.sh")
#
# Usage (git invokes these subcommands):
#   git-credential-gh.sh get    # emit credentials for a host
#   git-credential-gh.sh store  # no-op (keyring is SSOT; nothing to store)
#   git-credential-gh.sh erase  # no-op
#
set -euo pipefail

HOST=""
while IFS= read -r line; do
  case "$line" in
    protocol=*) PROTO="${line#protocol=}" ;;
    host=*)     HOST="${line#host=}" ;;
  esac
done

# Only handle github.com (and *.github.com). Everything else: fall through empty.
case "$HOST" in
  github.com|*.github.com) ;;
  *) exit 0 ;;
esac

# Single source of truth: the keyring. Never the env var (stale-token trap).
TOKEN="$(secretsmith get GH_TOKEN 2>/dev/null | grep -oE '(github_pat_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+)' | head -1)"

if [ -z "$TOKEN" ]; then
  # Fall back to gh's own keyring account if secretsmith is unavailable.
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi

if [ -n "$TOKEN" ]; then
  # Fine-grained PATs: username MUST be the token itself (x-access-token is rejected).
  printf 'username=%s\npassword=%s\n' "$TOKEN" "$TOKEN"
fi
exit 0