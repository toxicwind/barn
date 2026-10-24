# thresher — estate MCP federation fork (barn product)

**Thresher** is the estate's fork of [`smart-mcp-proxy/mcpproxy-go`](https://github.com/smart-mcp-proxy/mcpproxy-go)
(the upstream project originally shipped as MCPProxy). It is the
MCP control surface for the whole box: it federates ~55 upstream MCP servers,
discovers their tools with BM25, enforces auth/quarantine policy, and serves
the `:25127/mcp` endpoint every MCP client on the estate talks to.

> Thresher = the machine that beats the chaff out of the grain: it lets the
> relevant tools through and holds the rest back.

## Layout

```
pens/barn/thresher/
  bin/thresher                 # the gateway binary (Go, built from ./vendor)
  bin/thresher-mcp-stdio       # stdio MCP bridge (stdio clients -> :25127/mcp)
  bin/github-mcp.sh            # GitHub MCP launcher
  vendor/                      # upstream source + our estate patches (git)
  vendor.old-20261023/         # memorialized pre-fork snapshot (do not edit)
  build.sh                     # build the binary from ./vendor
  docs/UPGRADE-RUNBOOK.md      # how to re-sync with upstream
  docs/COVERAGE.md             # coverage state of the carried estate packages
```

## Lineage

| Layer | Source | State |
|---|---|---|
| Upstream | `smart-mcp-proxy/mcpproxy-go` @ `c82d515d` (2,033 commits) | full git history vendored |
| Our branch | `vendor` branch `estate/awrawr` (commit `7861ef21`) | estate patches on top of upstream HEAD |
| Old snapshot | `vendor.old-20261023/` | squashed, 2,033 commits behind — **kept for reference only** |

The old snapshot had **no shared history** with upstream (squashed at vendor
time), which is why drift went unnoticed for months. The current vendor dir
keeps real upstream ancestry, so `git log`/`git merge-base` answer drift
questions directly.

## Estate deltas carried on top of upstream

Carried (our code, on top of upstream HEAD):

- `cmd/mcpproxy/secrets_cmd.go` — secretsmith keyring integration (estate rule 3:
  secrets live in the keyring, never in source).
- `internal/config/server_edition_config.go` — server-edition config surface.
- `internal/contracts/intent.go`, `internal/contracts/types.go`,
  `internal/contracts/converters.go` — **variant calls** (intent routing).
- `internal/httpapi/scope.go`, `internal/httpapi/scope_subtree.go` — scope
  subtree selection for tool routing.

Deliberate posture (decided 2026-10-23, "anti-security / full YOLO"):

- Destructive tools are **auto-approved** via generic call
  (`tools_allow_destructive_via_generic_call`) — the estate prefers momentum
  over ceremony.
- **No quarantine layer** and **no sandbox** in the fork.
- Upstream's **TPA signature bundles** are adopted, but our `security_cmd.go`
  surface is kept alongside them.
- Auth: upstream's fail-closed constant-time compare and agent-token model,
  with the API key sourced from the secretsmith keyring.

## Runtime

- Daemon: `estate/thresher` in `estate/pitchfork.toml`.
- Entrypoint: `estate/ranch/range/bin/thresher-serve.ts` — injects
  `MCPPROXY_API_KEY` from secretsmith/`~/.secrets`, then execs
  `bin/thresher serve --config=estate/ranch/thresher/mcp_config.json --listen=127.0.0.1:25127`.
- Config SSOT: `estate/ranch/thresher/mcp_config.json` (seeded from
  `mcp_config.json.dist` if missing).
- Data dir: `~/.mcpproxy` (bolt DB + bleve index). **One instance per data
  dir** — a second `serve` on the same dir fails with a DB lock.
- stdio bridge: `~/.local/bin/thresher-mcp-stdio` and `estate/bin/thresher-mcp-stdio`.

### Secret quoting gotcha (cost us a 401)

`secretsmith env` emits values quoted (`MCPPROXY_API_KEY='abc…'`). Passing
that verbatim makes upstream's constant-time compare reject the token with
`401 Invalid authentication token`. `thresher-serve.ts` strips the quotes
(`unquote()`); keep that behavior if the secret plumbing changes.

## Health & regression gates

```bash
curl -s http://127.0.0.1:25127/health                       # {"status":"ok"}
python3 tests/timing_regression.py                          # search_servers < 1s
bash estate/bin/bin-verify.sh                               # link contract
pens/audit-links.sh                                         # product contract
```

## Building

```bash
bash build.sh            # -> bin/thresher
```
