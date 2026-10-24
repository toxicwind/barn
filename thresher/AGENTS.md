# thresher — product contract

Scoped rules for this product. The root `/home/toxic/AGENTS.md` is
authoritative; this file refines it for thresher only.

## What this is

A fork of `smart-mcp-proxy/mcpproxy-go` (upstream HEAD `c82d515d`) with estate
patches. It is the estate's MCP federation + control surface on `:25127/mcp`.

## Ownership

- **Source of truth**: `vendor/` (git clone of upstream + branch `estate/awrawr`).
- **Never edit** `vendor.old-20261023/` — memorialized snapshot, reference only.
- **One writer per subtree**: upstream files belong to upstream (rebase, don't
  hand-edit); `estate/awrawr` commits belong to us.
- The binary is built from `vendor/` — `bin/thresher` is a build artifact
  (rebuild via `build.sh`, never hand-patch the binary).

## Build & deploy

```bash
bash build.sh                                   # rebuild bin/thresher
cd /home/toxic/estate && pitchfork restart thresher   # deploy = restart
```

Deploy means a **running process uses the new binary**. After any vendor
change: rebuild → restart → `curl -s http://127.0.0.1:25127/health`.

## Ports & data

- `:25127` — the MCP endpoint. Do **not** add a `port =` field to the pitchfork
  daemon: pitchfork's pre-check binds `0.0.0.0` and false-conflicts with
  tailscaled's SNI forwarder on `100.72.199.93:25127`. Readiness is
  `health_http`-only.
- `~/.mcpproxy` — data dir (bolt DB + bleve index). **One `serve` per data dir.**
  For experiments always set `MCPPROXY_DATA_DIR` to a scratch dir.

## Config

- SSOT: `estate/ranch/thresher/mcp_config.json` (mode 0600).
- Seed from `mcp_config.json.dist` when missing (the serve script does it).
- The API key comes from the **secretsmith keyring** (via `secretsmith env`,
  fallback `~/.secrets`) — never hardcoded, and **quotes must be stripped**
  (upstream compares the raw string).

## Security posture (decided 2026-10-23)

Deliberately permissive: destructive auto-approve, no quarantine, no sandbox.
If you add a security control here, state it in the README — this posture is
a decision, not an oversight.

## Verification before claiming done

```bash
bash /home/toxic/estate/bin/bin-verify.sh          # link contract (30 ok)
/home/toxic/pens/audit-links.sh                     # product contract (26 ok)
python3 /home/toxic/pens/barn/thresher/tests/timing_regression.py
cd vendor && go test ./... -coverprofile=coverage.out   # see docs/COVERAGE.md
```

## Upstream sync

Read `docs/UPGRADE-RUNBOOK.md` first. It documents the shadow-instance
procedure (never cut over a sync you haven't run against `:25128`).
