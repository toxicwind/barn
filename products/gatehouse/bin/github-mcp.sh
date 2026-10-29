#!/usr/bin/env bash
# github MCP server launcher.
# Sources GITHUB_PERSONAL_ACCESS_TOKEN from gh's own credential store
# (~/.config/gh/hosts.yml, mode 0600) so no PAT is committed to this repo.
# The token is exported only into this process's environment.
set -euo pipefail
GH_HOSTS="${HOME}/.config/gh/hosts.yml"
if [ ! -f "${GH_HOSTS}" ]; then
  echo "github-mcp.sh: ${GH_HOSTS} not found; run 'gh auth login' first" >&2
  exit 1
fi
export GITHUB_PERSONAL_ACCESS_TOKEN
GITHUB_PERSONAL_ACCESS_TOKEN="$(python3 -c 'import sys,yaml,os; d=yaml.safe_load(open(os.path.expandvars("$HOME")+"/.config/gh/hosts.yml")); sys.stdout.write(d["github.com"]["oauth_token"])')"
exec npx -y @modelcontextprotocol/server-github
