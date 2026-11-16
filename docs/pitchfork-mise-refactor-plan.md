# Pitchfork / Mise Refactor Plan — ports.env orphans + daemon alignment

> Status: PLAN (approved — create todo from this and begin)
> Root: `/home/toxic/pens/barn/pitchfork.toml` + `/home/toxic/pens/barn/ssot/ports.env`
> Date: 2026-11-15

---

## 1. The problem

Pitchfork daemons and the ports.env SSOT have drifted:

- **ports.env orphans**: 5 copies exist under barn, only one is canonical.
  - `/home/toxic/pens/barn/ssot/ports.env` — self-declared DEPRECATED (2026-10-30), says "delete once every consumer is repointed". Still present.
  - `/home/toxic/pens/barn/products/pens/ssot/ports.env` — duplicate.
  - `/home/toxic/pens/barn/products/pens/config/ports.env` — the referenced canonical.
  - `/home/toxic/pens/barn/products/pens/config/flock-ssot/ports.env` — generated 20261004, stale.
  - `/home/toxic/pens/barn/products/pens/config/ranch/ports.env` — stale.
  - Plus archive copies under `archive/pre-reorg-20261029/`.
- **Blackbird already bypasses ports.env**: ports passed as explicit env in
  `barn/pitchfork.toml` (`BLACKBIRD_API_PORT=25112`, etc.). This is the
  pattern the refactor should generalize.
- **pitchfork.toml daemons** use `ready_http` (correct, `/health` not
  `/healthz`) but some daemons are stopped/errored (hindsight stopped,
  buildbuddy errored) — operational state, not config.

## 2. Goals

1. **Single ports SSOT**: one canonical `ports.env` (or better: eliminate the
   file entirely in favor of explicit env in pitchfork.toml, matching the
   blackbird pattern).
2. **Delete orphans**: remove the deprecated/duplicate ports.env copies after
   repointing consumers.
3. **Align pitchfork daemons**: every daemon passes ports as explicit env
   (no ports.env dependency), `ready_http` verified against live endpoints.
4. **Mise alignment**: daemons with `mise = true` must resolve the latest
   installed toolchain (bun 1.4.4, pitchfork 2.32.1).

## 3. Ports.env inventory

| Path | Status | Action |
|------|--------|--------|
| `barn/ssot/ports.env` | DEPRECATED self-declared | Delete after repoint |
| `barn/products/pens/ssot/ports.env` | duplicate | Delete |
| `barn/products/pens/config/ports.env` | canonical (referenced) | Keep as SSOT or migrate to pitchfork env |
| `barn/products/pens/config/flock-ssot/ports.env` | generated 20261004, stale | Delete |
| `barn/products/pens/config/ranch/ports.env` | stale | Delete |
| `archive/pre-reorg-20261029/ssot/ports.env` | archive | Leave (archive) |

## 4. Consumers to repoint

- `forge/router/herd/cmd/herd-launcher/main.go`
- `forge/router/herd/cmd/herd-plane/main.go`
- `forge/router/herd/herd-selfheal.sh`
- `forge/router/stoat/pens-router-ts/**` (router.ts, router_config.ts, variants/*)
- `forge/router/weasel/open-sse/config/semanticCacheConfig.ts`
- Any `requirePort` callers

Repoint strategy: read the canonical `config/ports.env` (single source), or
better — inject ports via pitchfork daemon `env = {...}` like blackbird does.

## 5. Pitchfork daemon alignment

- Verify every daemon `ready_http` hits a live endpoint (done 2026-11-15:
  all 200 except hindsight/buildbuddy which are stopped/errored — operational).
- Convert remaining daemons that read ports.env to explicit `env = {...}`.
- `mise = true` daemons: confirm latest toolchain (bun 1.4.4).

## 6. Execution order

1. Audit all ports.env consumers (grep `ports.env|requirePort`).
2. Repoint consumers to canonical (or pitchfork env).
3. Delete orphan ports.env copies.
4. Update pitchfork.toml daemons to explicit env where feasible.
5. Restart affected daemons, verify ready_http.
6. Run full test suite for touched products.
