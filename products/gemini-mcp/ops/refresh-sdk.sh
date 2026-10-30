#!/usr/bin/env bash
# Nightly refresh of the maximal Google API SDK surface for gemini-mcp.
# NOTE 2026-09-14: google-generativeai is DEPRECATED upstream (end of support);
# google-genai is the current unified SDK. Both are kept installed so legacy
# imports keep working, but new code should use google.genai.
set -euo pipefail
VENV=/home/toxic/.gemini-sdk-venv
"$VENV/bin/pip" install -q -U pip
"$VENV/bin/pip" install -q -U \
  google-genai \
  google-generativeai \
  google-ai-generativelanguage \
  google-api-python-client
"$VENV/bin/python" -c "import google.genai, google.ai.generativelanguage, googleapiclient; print('sdk-ok')"
