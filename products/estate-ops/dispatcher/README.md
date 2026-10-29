<div align="right">

[![license](https://img.shields.io/badge/license-MIT%20%2B%20upstream-blue?style=for-the-badge)](https://github.com/toxicwind/estate-scripts-projects#license)
[![estate-scripts-projects](https://img.shields.io/badge/estate-scripts--projects-part%20of-blueviolet?style=for-the-badge)](https://github.com/toxicwind/estate-scripts-projects)

</div>

# Fleet dispatcher/ledger (canonical)

**One place that answers: who was admitted to do what, what happened, what got built, and who overrode whom.** The canonical dispatcher and audit ledger for the agent fleet — file-based, daemonless, and restart-proof.

## Why should I care?

- **Atomic ID issuance** — `mission`/`coordinator`/`worker`/`relay` IDs, atomic across processes (flock counters, O_EXCL relay claims)
- **direct-the Architect precedence, enforced in code** — `chris-direct` (100) preempts `coordinator` (50), `oracle` (40), `agent` (10)
- **Tamper-evident** — append-only hash-chained ledger + per-relay hash-chained records; `dispatch audit` replays every chain and re-checks every lane
- **No daemon to restart** — everything is files; kill the process, reboot the box, construct a new `Dispatcher` on the same dir and IDs, locks, and the ledger chain continue

## Features

- **ID issuance** — `mission` / `coordinator` / `worker` / `relay` IDs, atomic across processes (flock counters, O_EXCL relay claims).
- **Lifecycle + result tracking** — `admitted → running → stalled → completed | failed | killed`, with results carrying success flags, summaries, artifacts, and commit SHAs.
- **Duplicate-admission locks** — a dedup key admits exactly once while its lock is live; stale locks are reclaimed, lower-precedence retries are refused fail-closed.
- **Append-only relay records** — each relay owns a hash-chained `records.jsonl`; writers only append, readers never mutate.
- **Artifact/commit aggregation** — per-result artifact + SHA registration (SHAs validated), mission-level manifests.
- **Automatic relay archival** — a worker/coordinator's relay seals the moment its result is recorded. No timers, no sweeps needed; `archive-sweep` exists only as idempotent repair.
- **Exactly-four-audit-lanes enforcement** — the ledger writer rejects any lane outside the canonical four, fail-closed.

```mermaid
flowchart TD
    I[intake hook] --> M[mission admitted]
    M --> C[coordinator admitted]
    C --> W[worker admitted]
    W --> T[transitions: running → stalled → completed/failed/killed]
    T --> R[result recorded: summary + artifacts + commit SHAs]
    R --> S[relay sealed & archived]
    subgraph lanes["4 audit lanes — enforced fail-closed"]
        D1[dispatch]
        D2[lifecycle]
        D3[artifact]
        D4[governance]
    end
    R --> D1 & D2 & D3 & D4
```

## Quick start

```bash
bin/dispatch admit-mission --slug x --origin chris-direct --brief "..."
bin/dispatch admit-worker --name w --mission m-x-20260921-001 --origin coordinator --brief "..."
bin/dispatch result --id w-w-001 --success true --summary "done" --commit <sha>
```

## License & security

- [MIT](https://github.com/toxicwind/estate-scripts-projects#license).
- Precedence is enforced in code, not convention: lower-precedence origins cannot preempt higher ones, and the ledger rejects writes outside the four canonical lanes. State lives in files under `state/` (gitignored runtime state); the code and tests are committed.

## The four audit lanes

| Lane | Records | Answers |
|---|---|---|
| `dispatch` | admissions, assignments, intake decisions/refusals/duplicates | who was told to do what |
| `lifecycle` | transitions, results, relay seals | what happened over time |
| `artifact` | artifact + commit registrations, mission manifests | what got built, where it lives |
| `governance` | lock acquired/refused/preempted/reclaimed, chris-direct overrides, relay archival | who overrode whom, why work was refused |

`Ledger.append(lane, ...)` raises `LaneViolation` for anything else. `dispatch audit` replays every chain and re-checks every lane.

## ID scheme

```
mission:     m-<slug>-<yyyymmdd>-<seq>     m-dispatcher-20260921-001
coordinator: c-<name>-<seq>                c-pack-keeper-004
worker:      w-<name>-<seq>                w-stall-slayer-012
relay:       relay-<agent-name>             relay-stall-slayer
             (re-entrant name → relay-<name>-2, claimed atomically)
```

IDs are unique, not gapless: a refused duplicate admission mints an ID and then refuses it, burning one counter step. The ID is never registered (no entity file, no ledger record), so gaps are harmless by design.

## Architecture — state layout

```
projects/ops/dispatcher/state/        ← runtime state, gitignored
  ledger.jsonl                          fleet ledger (hash-chained)
  entities/<entity-id>.json             one file per mission/coordinator/worker
  locks/<sha1(dedup)>.lock              admission locks (heartbeated)
  counters/*.ctr                        flock-guarded ID counters
  relay-claims/relay-<name>             atomic relay claims
  relays/<relay-id>/records.jsonl      relay's own hash-chained log
  relays/<relay-id>/summary.json        written once at seal
  relays/archive.jsonl                  global archival index
```

Everything is files. Kill the process, reboot the box, construct a new `Dispatcher` on the same dir — IDs continue, locks hold, the ledger chain continues. There is no in-memory state that matters and no daemon to restart.

## CLI reference

```bash
bin/dispatch --state <dir> admit-mission --slug dispatcher \
  --origin chris-direct --brief "build the ledger"
bin/dispatch admit-worker --name stall-slayer --mission m-dispatcher-20260921-001 \
  --origin coordinator --brief "forensics" --coordinator c-pack-keeper-004
bin/dispatch transition --id w-stall-slayer-012 --to running
bin/dispatch result --id w-stall-slayer-012 --success true --summary "done" \
  --artifact projects/ops/stall-detect/queries.sql --commit 0eb76b496d
bin/dispatch status [--id w-stall-slayer-012]
bin/dispatch manifest --mission m-dispatcher-20260921-001
bin/dispatch audit            # verify all chains + lanes; exit 1 on break
bin/dispatch archive-sweep    # idempotent repair for unsealed terminal relays
bin/dispatch intake --from ember --text "probe herd health" --origin agent
```

Exit codes: 0 ok · 3 duplicate-admission · 4 unknown-entity · 5 illegal-transition · 6 bad-request.

## Intake hook

`intake_submit({"from","text","origin"})` is the admission endpoint for the oracle front door: non-empty requests become missions deduped on text hash; empties are refused; repeats report the existing holder. Full triage (TASK/DEBATE/RESEARCH/…) stays in `agents/oracle-market/bin/oracle_intake.py` — this is the dispatch side.

## Boundaries (borrowed, not duplicated)

- `tools/estate-scripts-chat/dispatch.ts` — estate-scripts-chat's **internal** lease queue (bun:sqlite, wedge semantics). Task-level, inside the chat process. This dispatcher is fleet-mission level, above it.
- `fleet/dispatch_fallback.py` — client-side fallback that queues dispatch frames to the directives file when the chat server is unreachable. Complementary transport, not a ledger.
- `agents/oracle-market/` — the oracle market loop: task bidding, intake triage, bidder workers. Its `bin/oracle_loop.py` tracks market tasks; this dispatcher tracks fleet missions/coordinators/workers and their relays. The intake hook above is the seam between them.

## Dev & contributing

```bash
cd projects/ops/dispatcher && python3 -m unittest discover -s tests -v
```

Stdlib only. Covers: ID uniqueness (incl. 8-thread races), relay claim races, duplicate-admission (incl. 12-thread race), chris-direct preemption, stale-lock reclaim, four-lane enforcement, chain tamper detection, read-only readers, full worker lifecycle, illegal transitions, stall recovery, SHA validation, manifest aggregation, archive-sweep repair, intake dedup, and restart continuity (new `Dispatcher`, same dir).

**Durability:** no daemons, no timers, no polling — the CLI runs on events; heartbeats are caller-driven. Restart test (`TestRestart`) proves a fresh process continues IDs, locks, and the ledger chain on the same state dir. Survives full yote reboot: state is on disk under `state/`; code + tests are committed.

See also: `docs/fleet-knowledgebase.md` §2 (crew registry), `docs/spawn-brief-template.md` (briefs this dispatcher admits), `projects/ops/README.md`.
