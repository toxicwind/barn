# thresher — estate MCP federation fork (barn product)

**Thresher** is the estate's fork of [`smart-mcp-proxy/mcpproxy-go`](https://github.com/smart-mcp-proxy/mcpproxy-go)
(the upstream project originally shipped as MCPProxy). It is the
MCP control surface for the whole box: it federates ~55 upstream MCP servers,
discovers their tools with BM25, enforces auth/quarantine policy, and serves
the `:25127/mcp` endpoint every MCP client on the estate talks to.

> Thresher = the machine that beats the chaff out of the grain: it lets the
> relevant tools through and holds the rest back.

## What this repo is

This repository **is** the product. The estate forked `mcpproxy-go` and
extended it in place (module root), rather than building from a separate
vendored upstream clone. The gateway is compiled directly from
`./cmd/mcpproxy` in this tree.

- `cmd/mcpproxy` — the `serve` gateway binary entrypoint.
- `internal/…` — server, config, upstream orchestration, tray, TUI, security.
- `web/` — the embedded management UI.
- `bin/thresher` — build artifact from `build.sh` (gitignored).

## Layout

```
pens/barn/thresher/
  cmd/mcpproxy                # the Go gateway entrypoint (module root)
  build.sh                    # go build -o bin/thresher ./cmd/mcpproxy
  tests/coverage_gate.sh      # coverage gate on estate-owned packages
  docs/UPGRADE-RUNBOOK.md     # how to re-sync with upstream
  docs/COVERAGE.md            # coverage state of the carried estate packages
  _archive/vendor-20261024/   # pre-merge upstream clone snapshots (reference only)
```

## Lineage

| Layer     | Source                                                     | State                 |
| --------- | ---------------------------------------------------------- | --------------------- |
| Upstream  | `smart-mcp-proxy/mcpproxy-go` @ `c82d515d` (2,033 commits) | merged as module root |
| This fork | estate extensions on top of upstream HEAD                  | working tree + `main` |

The 2026-10-24 merge folded the vendored upstream clone (`vendor/`,
`vendor.old-20261023/`) into the module root and moved those snapshots to
`_archive/vendor-20261024/` for reference. There is no separate vendored
build source anymore — `build.sh` builds this tree directly.

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
bash build.sh            # -> bin/thresher  (from ./cmd/mcpproxy)
```
