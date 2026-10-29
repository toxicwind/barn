<div align="right">

[![license](https://img.shields.io/badge/license-MIT%20%2B%20upstream-blue?style=for-the-badge)](https://github.com/toxicwind/estate-scripts-projects#license)
[![estate-scripts-projects](https://img.shields.io/badge/estate-scripts--projects-part%20of-blueviolet?style=for-the-badge)](https://github.com/toxicwind/estate-scripts-projects)

</div>

# lane-verify — claim-vs-evidence lane verification

**A claimed restart is not a restart.** The executable form of the hardened
wave4 retry protocol (2026-10-02): a lane claimed `restarted` / `running` /
`done` with no observed tool calls, files, or test output after the claim
counts as **STALLED** — it is rolled back to its checkpoint and rerouted,
never reported as complete.

This is the scheduled-lane complement to `stall-detect/` (DB forensics on
agent executions): lane-verify checks *claims about lanes* against *observed
artifacts on the box*.

## Why should I care?

- The 2026-10-02 02:11 UTC scheduled run recorded `status=succeeded` with
  **zero lanes dispatched** — the exact claimed-restart-did-nothing bug.
  lane-verify catches that shape mechanically: claim `done`, zero observed
  artifacts → STALLED + reroute spec.
- Verdicts are deterministic and evidence-grounded: every rule cites the
  evidence refs it rests on (file sha256s, commit SHAs, heartbeat mtimes).
  No LLM, no prose scoring — the design borrows the evidence-grounding
  discipline from arXiv:2601.08654 (*From Rubrics to Reliable Scores*,
  2026) and the staleness-window pattern from the GitHub-ranked *worker
  heartbeat stall detection* pattern (pattern-borrow.ts: score 50.0,
  60,053 stars across 8 repos, test frac 0.75).

## Quick start

```bash
# 1. Write the claim (what the lane or scheduler ASSERTS):
cat > /tmp/claim.json <<'EOF'
{
  "lane": "wave4-router-max",
  "claim": "restarted",
  "claimed_at": "2026-10-02T11:48:00Z",
  "watch_dirs": ["/home/toxic/estate/tools/estate-scripts-router"],
  "checkpoint_file": "/home/toxic/estate/checkpoints/wave4.json"
}
EOF

# 2. Verify it against observed state:
bun bin/lane-verify.ts --claim /tmp/claim.json --append-checkpoint
# exit 0 = PROGRESSING | DONE_VERIFIED, exit 2 = STALLED, 1 = bad claim

# 3. Run the test suite:
bun test
```

## Rules

| Rule | What it checks |
|---|---|
| `claim-wellformed` | `claimed_at` parses and is not in the future |
| `observed-activity` | ≥1 file / commit / receipt at or after `claimed_at` |
| `heartbeat-fresh` | heartbeat file mtime within `heartbeat_window_s` (when configured) |
| `done-requires-artifacts` | a `done` claim needs ≥1 file or commit |

**Fail-closed:** any evidence-gathering failure yields STALLED with an
explicit note. We never verify on unknown state.

On STALLED the verdict carries a `reroute` spec: the failed rules, the
checkpoint reference, and the concrete next step (roll back to checkpoint,
confirm by direct observation, redo through a different route — never
hot-loop the same failing call). With `--append-checkpoint` the verdict is
appended to the checkpoint file in the wave4 event schema.

## Layout

- `src/claim.ts` — LaneClaim schema + validation
- `src/evidence.ts` — observed-activity gatherers (files+sha256, git commits, heartbeats)
- `src/verdict.ts` — the deterministic judge: rules → verdict → reroute spec
- `src/checkpoint.ts` — checkpoint appends in the wave4 event schema
- `bin/lane-verify.ts` — CLI (exit 2 on STALLED)
- `rubrics/wave4-lane.json` — default rubric for wave4-style scheduled lanes
- `tests/lane-verify.test.ts` — 11 tests, all against real filesystem state

## Research lineage

- Paper search (paper-poller, 2026-10-02): *LoopsBench: From Harness
  Engineering to Loop Engineering in Coding Agent Evaluation*
  (arXiv:2608.00267); *From Rubrics to Reliable Scores: Evidence-Grounded
  Text Evaluation with LLM Judges* (arXiv:2601.08654); *LLM-Rubric*
  (2024); *A Survey on Evaluation of LLM-based Agents* (2026).
- Pattern borrow (pattern-borrow.ts, GitHub-wide, 2026-10-02):
  `worker heartbeat stall detection` (50.0), `llm judge evaluation
  harness` (13.9), `coding agent eval benchmark harness` (12.7).
- Built by the wave4-emergent lane (paper-search × pattern-borrow
  combined into a build the estate lacked).

## License & security

- [MIT](https://github.com/toxicwind/estate-scripts-projects#license).
- Read-only against the box except `--append-checkpoint` writes to the
  checkpoint file you name. Never touches credentials, money, or network.
