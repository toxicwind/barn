#!/usr/bin/env bash
# chromium-keyring — SUPERSEDED by secretsmith (mesh project).
# Thin shim for muscle memory; one truth lives in secretsmith.
case "${1:-check}" in
  check) exec secretsmith check ;;
  attrs) exec secretsmith search --schema chromium ;;
  key)   exec secretsmith chromium-key --show ;;
  *) echo "chromium-keyring: superseded by secretsmith; usage: chromium-keyring {check|attrs|key}" >&2; exit 2 ;;
esac
