#!/bin/bash
# omniroute-secrets.sh — launch OmniRoute gateway with estate secrets loaded.
# Sources /home/toxic/.secrets so provider keys (OPENAI_API_KEY,
# ANTHROPIC_API_KEY, etc.) are in the environment. Chris 2026-10-05:
# omniroute must use /home/toxic/.secrets.
set -a
# shellcheck disable=SC1091
[ -f /home/toxic/.secrets ] && . /home/toxic/.secrets
set +a
exec omniroute "$@"
