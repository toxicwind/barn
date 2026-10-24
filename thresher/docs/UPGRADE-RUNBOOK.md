# Upgrading thresher with upstream

How to re-sync `vendor/` with `smart-mcp-proxy/mcpproxy-go` without
repeating the 2,033-commit drift rot we inherited.

## 0. Preconditions

- `vendor/` is a full clone (real upstream ancestry — verify with
  `git -C vendor log --oneline | wc -l`; expect ~2,000+ commits).
- Our branch `estate/awrawr` exists and is based on upstream `main`.
- `bin/thresher` builds: `bash build.sh`.
- The daemon is healthy: `curl -s http://127.0.0.1:25127/health`.

## 1. Fetch upstream

```bash
cd /home/toxic/pens/barn/thresher/vendor
git fetch origin '+refs/heads/*:refs/remotes/origin/*'
git log --oneline origin/main -1        # newest upstream commit
```

There is **no canary/nightly branch upstream** — `origin/main` *is* the
bleeding edge. Branches like `remove-tool-search-bm25` are old experiments
(1,163+ commits behind main); don't sync to them.

## 2. Rebase our estate branch

```bash
git checkout estate/awrawr
git rebase origin/main          # our patches replay onto new upstream
# resolve conflicts FORWARD: keep upstream's new behavior, re-apply our
# deltas on top. Never "theirs" wholesale — upstream owns the base files.
```

Carried estate patches (keep these alive through every sync):

- `cmd/mcpproxy/secrets_cmd.go`
- `internal/config/server_edition_config.go`
- `internal/contracts/{intent,types,converters}.go`
- `internal/httpapi/scope{,_subtree}.go`

If upstream adds an equivalent of one of these, prefer upstream's and drop
ours — then update this list and `README.md`.

## 3. Build

```bash
cd /home/toxic/pens/barn/thresher
bash build.sh                    # -> bin/thresher
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
**0.173s**; our pre-fork snapshot returned 401/timeout.)

## 5. Cut over

```bash
cd /home/toxic/estate
pitchfork restart thresher
curl -s http://127.0.0.1:25127/health
python3 /home/toxic/pens/barn/thresher/tests/timing_regression.py
```

Rollback: the pre-fork snapshot is preserved at
`pens/barn/thresher/vendor.old-20261023/` and the previous binary at
`bin/thresher.prev` (if the build kept it) — otherwise rebuild from the old
snapshot and restart.

## 6. Record the sync

- Update `README.md` (upstream commit hash + estate delta list).
- Update `docs/COVERAGE.md` with the new baseline.
- Commit on `estate/awrawr`; push the branch.
- Run both contract verifiers:
  `bash estate/bin/bin-verify.sh` and `pens/audit-links.sh`.

## Drift check (automation)

`estate/bin/bin-contract-audit.sh` (pitchfork daemon `estate/bin-contract-audit`)
verifies links on every run. Upstream-drift detection is a separate check —
see `docs/COVERAGE.md` for the current script and how to add a
`git rev-list --count origin/main..HEAD` assertion to the canary.
