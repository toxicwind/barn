#!/usr/bin/env bash
for f in "$@"; do
  [ -f "$f" ] || { echo "MISSING: $f"; continue; }
  echo "════════════════════════════════════════════════════════════════"
  echo "FILE: $f"
  echo "SIZE: $(wc -c < "$f") bytes, $(wc -l < "$f") lines"
  echo "════════════════════════════════════════════════════════════════"
  cat -v "$f"
  echo
  echo
done
