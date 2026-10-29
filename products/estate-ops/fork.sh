#!/bin/bash
# fork.sh <owner/repo> — fork to toxicwind, clone to /home/toxic/<name>, set upstream remote.
# Runs ON awrawr-pc (has gh auth). Called via the awrawr-mcp bridge.
set -euo pipefail
SRC="${1:?usage: fork.sh <owner/repo>}"
NAME="$(basename "$SRC")"
DEST="/home/toxic/$NAME"

if [ -d "$DEST" ]; then echo "exists: $DEST"; exit 0; fi

gh repo fork "$SRC" --clone=false 2>&1 | tail -1
git clone "git@github.com:toxicwind/$NAME.git" "$DEST" 2>&1 | tail -1
cd "$DEST"
git remote add upstream "https://github.com/$SRC.git" 2>/dev/null || true
git remote -v | head -4
echo "forked: toxicwind/$NAME <- $SRC"
