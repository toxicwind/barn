#!/usr/bin/env bash
# apply.sh <name> — instantiate this scaffold as a new pens repo.
#   cp -r scaffold pens/<name>; cd pens/<name>; ./bin/apply.sh <name>
set -euo pipefail
NAME="${1:?usage: bin/apply.sh <name>   (pens/<name>)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in AGENTS.md README.md package.json; do
  [ -f "$f" ] && sed -i "s#<PEN_NAME>#$NAME#g; s#<pen-name>#$NAME#g" "$f"
done
echo "✔ scaffold applied as pens/$NAME"
echo "  next: edit README product table, then:"
echo "  · git init && git add .gitignore README.md LICENSE package.json mise.toml AGENTS.md bin/ && git commit"
echo "  · symlink products into ~/.local/bin + regenerate manifest (estate-ops bin/manifest-gen.py)"
