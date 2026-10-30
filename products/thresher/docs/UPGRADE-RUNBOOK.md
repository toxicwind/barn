# Upgrading thresher with upstream

How to re-sync this fork with upstream [`smart-mcp-proxy/mcpproxy-go`](https://github.com/smart-mcp-proxy/mcpproxy-go)
without repeating the 2,033-commit drift rot we inherited.

Upstream was **merged into the module root** (2026-10-24): there is no
separate `vendor/` build source anymore. `./cmd/mcpproxy` in this tree **is**
the product, and `build.sh` compiles it directly. Prior vendored clones live
only under `_archive/vendor-20261024/` for reference.

## 0. Preconditions

- This repo tracks upstream as a remote so `git fetch` + `rebase` stay
  ancestry-based. Verify: `git remote -v` shows `smart-mcp-proxy/mcpproxy-go`.
- Add it if missing:
  `git remote add upstream https://github.com/smart-mcp-proxy/mcpproxy-go.git`
- `bin/thresher` builds: `bash build.sh`.
- The daemon is healthy: `curl -s http://127.0.0.1:25127/health`.

## 1. Fetch upstream

```bash
git remote add upstream https://github.com/smart-mcp-proxy/mcpproxy-go.git   # once
git fetch upstream '+refs/heads/*:refs/remotes/upstream/*'
git log --oneline upstream/main -1        # newest upstream commit
```

There is **no canary/nightly branch upstream** — `upstream/main` _is_ the
bleeding edge. Branches like `remove-tool-search-bm25` are old experiments
(1,163+ commits behind `main`); don't sync to them.

## 2. Rebase our estate commits

```bash
git checkout main
git rebase upstream/main          # our patches replay onto new upstream
# resolve conflicts FORWARD: keep upstream's new behavior, re-apply our
# deltas on top. Never "theirs" wholesale — upstream owns the base files.
```

Carried estate deltas (keep these alive through every sync):

- `cmd/mcpproxy/secrets_cmd.go` — secretsmith keyring integration
- `internal/config/config.go` — `tools_allow_destructive_via_generic_call`
  (estate posture: destructive auto-approve)
- `internal/contracts/{intent,types,converters}.go` — variant/intent routing
- `internal/httpapi/scope{,_subtree}.go` — scope subtree selection
- `tests/` — estate-owned coverage gate (`tests/coverage_gate.sh`)

If upstream adds an equivalent of one of these, prefer upstream's and drop
ours — then update this list, `README.md`, and `docs/COVERAGE.md`.

## 3. Build

```bash
bash build.sh                    # -> bin/thresher  (from ./cmd/mcpproxy)
bin/thresher --version
```

## 4. Shadow-test before cutting over (never skip)

A second instance must use its **own data dir** — two `serve` processes on one
data dir deadlock on the bolt DB.

```bash
mkdir -p /home/toxic/tmp/thresher-shadow
cp estate/ranch/thresher/mcp_config.json /home/toxic/tmp/thresher-shadow/
MCPPROXY_DATA_DIR=/home/toxic/tmp/thresher-shadow \
  ./bin/thresher serve --config=/home/toxic/tmp/thresher-shadow/mcp_config.json \
  --listen=127.0.0.1:25128 &
curl -s http://127.0.0.1:25128/health            # {"status":"ok"}
```

Then time the calls that matter:

```bash
python3 tests/timing_regression.py --url http://127.0.0.1:25128/mcp
# search_servers must answer well under 1s
```

(2026-10-23 reference: upstream `c82d515d` answered `search_servers` in
**0.173s**; our pre-merge snapshot returned 401/timeout.)

## 5. Cut over

```bash
cd /home/toxic/estate
pitchfork restart thresher
curl -s http://127.0.0.1:25127/health
python3 /home/toxic/pens/barn/thresher/tests/timing_regression.py
```

Rollback: the pre-merge vendored clone is preserved at
`pens/barn/thresher/_archive/vendor-20261024/`; rebuild from the current source
or that snapshot and restart.

## 6. Record the sync

- Update `README.md` (upstream commit hash + estate delta list).
- Update `docs/COVERAGE.md` with the new baseline.
- Commit on `main`; push the branch.
- Run both contract verifiers:
  `bash estate/bin/bin-verify.sh` and `pens/audit-links.sh`.

## Drift check

`estate/bin/bin-contract-audit.sh` (pitchfork daemon `estate/bin-contract-audit`)
verifies links on every run. Upstream-drift detection is a separate check —
see `docs/COVERAGE.md` for how to add a
`git rev-list --count upstream/main..HEAD` assertion to the canary.
