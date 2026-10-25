<div align="right">

[![license](https://img.shields.io/badge/license-MIT%20%2B%20upstream-blue?style=for-the-badge)](https://github.com/toxicwind/sovereign-projects#license)
[![sovereign-projects](https://img.shields.io/badge/sovereign--projects-part%20of-blueviolet?style=for-the-badge)](https://github.com/toxicwind/sovereign-projects)

</div>

# stall-detect — DB-forensics stall detection

**An error string is a CLAIM, not a fact.** The permanent stall-detection deliverable for the fleet — the **DB-forensics lane**: executions, tool calls, transcripts, mailbox, recovery ownership. The live-process lane (ps, CPU, py-spy, strace, ports) is explicitly out of scope — it belongs to the live-proc hunter; do not duplicate their hunt. Coordinate via squawk fleet, divide targets there before probing.

## Why should I care?

- **The query pack IS the script** — `queries.sql` is executed by any agent with the `muse_db` skill; an agent running it once is proof, the committed pack is the deliverable
- **Executable error-claim runbook** — severity-graded (`mislead` / `transient` / `genuine`), with the exact verification commands before anyone acts on a string
- **Anti-false-diagnosis loop** — the classifier publishes CLAIM-CHECK notes to fleet so the pack learns the required verification BEFORE acting

```mermaid
flowchart TD
    Q[queries.sql — Q1..Q10] --> C{classify}
    C -->|mislead| V[verify against ps/df/logs first]
    C -->|transient| R[retry, don't escalate]
    C -->|genuine| A[act: route, stop, report]
    V --> F[fleet CLAIM-CHECK notes]
    A --> F
```

## Quick start

```bash
# 1. Read /opt/hatch/skills/muse_db/references/schema.md first.
# 2. Run Q1–Q5 (fleet census), Q6–Q7 (trace one stale record), Q8–Q10 (error-claim harvest).
agent-reaper --classify-errors candidates.json   # candidates: [{id, source, error_text}]
```

Run on demand, never as a polling daemon (event-driven fleet reporting only).

## License & security

- [MIT](https://github.com/toxicwind/sovereign-projects#license).
- Diagnosis is hands-off unless the resume path says so. **Never kill anything from forensics alone** — the reaper never escalates, never closes, never diagnoses unknown text.

## Error-claim runbook (Q8/Q9/Q10) — executable, not prose

An error string is a CLAIM, not a fact. The unreliable-narrator doctrine (AGENTS.md §5) is the law here: what actually happened outranks what the error says happened. A diagnosis that trusts the string can kill healthy work — the 2026-09-20 scars: pip "No space left on device" at 2% disk used, the HF whoami probe 401ing on valid tokens, a 21,050s "stalled" ledger that was a healthy quiet market, a ~3-minute bridge 401 that self-recovered.

The shared catalog (`hatch/bin/error_claims.py`, `ERROR_CLAIM_CATALOG`) holds the estate's known claims. `agent-reaper --classify-errors` applies them; `progress-watchdog`'s `cond()` annotates every alert with the catalog probe. Severity decides the workflow:

**mislead — verify BEFORE acting** (the string routinely lies):
- `disk-full`: run `df -h / && df -i / && df -h /tmp`. Trust df, not the string. Retry on headroom; a full /tmp is not a full /.
- `token-dead-probe`: validate against the authoritative endpoint (a real API call). Never declare a token dead from a probe endpoint.
- `exec-hang`: `ps aux | grep bg-launch` + check the output file / mailbox (substitute the stuck command's own name). Bridge exec has fail-fast ceilings (120s WS / 180s HTTP) — stalls are unreaped rows, not hung calls. Re-issue the work; don't chase a hang.
- `ledger-stall`: `pgrep -af monitor.ts` + check the intake dir for pending files (substitute the loop process's own name). Ledger age alone is not a finding — it cannot distinguish a dead loop from a quiet market.
- `meter-limit`: attempt the tool call. Only an actual refusal counts as a limit; meter language is narrator noise. Keep working.

**transient — retry, don't escalate**:
- `spawn-lock-timeout`: confirm no spawn row (`SELECT status FROM agent.agents WHERE agent_id='w-stall-slayer-012'` — substitute the agent's own id). Nothing orphaned, nothing to close — the parent retries the spawn. Do not reap errored spawn rows.
- `bridge-401`: wait 2–3 minutes, retry. Only escalate to Chris (token mint via the vault page) if it persists >5 minutes.

**genuine — act on it**:
- `conn-refused`: `ss -ltnp | grep <port>` + `tailscale serve status`. The listener is usually on the wrong interface (tailscale vs loopback) or the port moved in the serve map — verify before declaring an outage.
- `provider-rate-limit` (429 / `connector_rate_limited`): HARD STOP for that provider scope this attempt. Report partial progress; no sleep-retry, no delegation around it.
- `quota-402`: route through a different provider lane; flag to Chris.
- `eaddrinuse`: `ss -ltnp | grep <port>` vs the supervisor's tracked pid. Pick the canonical holder, remove the loser — never kill loops.

**Anti-false-diagnosis loop**: `agent-reaper --classify-errors candidates.json --fleet-notes` publishes CLAIM-CHECK notes to fleet for high-confidence `mislead` claims (deduped by md5 of the error text, fail-soft), so the fleet learns the required verification BEFORE anyone acts on the string. The reaper never escalates, never closes, never diagnoses unknown text.

## Classification table (2026-09-20 baseline evidence)

| Query | Finding | Verdict | Safe resume path |
|---|---|---|---|
| Q1 | `running` agent, idle >12h, visible transcript = repeated `nothing_to_do`, no spawn row, no parent | Dormant system worker, not blocked work | Hands off. Trace ownership (Q7) before touching. Do NOT respawn or close. |
| Q2 | Tool call with no output, age >1h | Stuck mid-call execution | Correlate with the owning agent's transcript (Q6) and live-proc lane; resume = retry the call or let the owner re-issue it. |
| Q3 | Mailbox submission `accepted`/`attached`, age >1h | Stuck delivery | Trace `agent_id` → owner agent; check owner is alive (Q1). Resume = owner re-attaches; do not fabricate delivery. |
| Q4 | `recovery_owners` row, `terminal_at` NULL, age >1h | Dangling recovery | Check `agent.recovery_owner_terminal_events`; resume = owner completes terminal event or a coordinator terminalizes after verifying no live owner. |
| Q5 | `errored` agent, `last_assistant_message` = "subagent reservation failed before spawn row persistence: … lock timeout" | Failed spawn reservation — spawn row never persisted, no child ever ran | Nothing orphaned, nothing to resume. Parent retries the spawn. Lock contention from a noon swarm is the usual cause. |
| Q8 | Error-shaped string in an agent final message | CLAIM, not fact — most hits are completed agents whose reports merely mention errors | Classify with `agent-reaper --classify-errors`; follow the runbook workflow for the matched claim. Unclassified → investigate raw. |
| Q9 | Failed tool output with error text | CLAIM, not fact (lane empty in this cell's view) | Classify; `mislead` severities get verified before any action. |
| Q10 | Failed tool event (`tool_status='failed'`) | Usually a genuine tool failure (exit 1, edit mismatch) — the classifier correctly returns no claim | Fix the tool invocation or let the owner re-issue. No catalog claim ≠ no problem; it means the error isn't a known mislead. |

## Baseline run (2026-09-20 ~15:45 MDT)

- Q2: **0 rows** — every recorded tool call has a matching output. No stuck mid-call work.
- Q3: 59 non-terminal submissions, all <1h old — fresh traffic, nothing stuck.
- Q4: **0 rows** — all recovery owners terminalized.
- Q1: two stale `running` worker records (18.8h + 4.9h idle), both `nothing_to_do`-only transcripts, no spawn rows → dormant system workers, hands-off pending ownership trace.
- Q5: two errored agents (0.3h), both pre-spawn lock-timeout failures → no orphan, parents retry.

## Baseline run — error-claim harvest (2026-09-20 ~17:30 MDT)

- Q8: **202** error-shaped final messages (out of 3,593 agents). Sampled top-50: all `completed` agents whose final reports merely *mention* failures ("10 Mistral + 1 Gemini + 4 OpenRouter failures", "ran=9 failed=15") — zero stall claims. This is why the harvest must be classified, not acted on.
- Q9: **0 rows** — `runtime.tool_calls`/`runtime.tool_outputs` are EMPTY in this cell's `muse.db` view (verified 2026-09-20). The lane is documented for views where the tables are populated.
- Q10: **1,185** failed tool events (24,449 started / 23,258 completed / 1,185 failed), all with previews — genuine tool failures (exec exit 1, edit mismatch, browser action failures). The classifier returns no catalog claim for these, correctly: a failed tool is not a misleading error claim.

## Lane division (registered in fleet seq 11434)

- **stall-slayer (this lane):** DB forensics + safe resume paths.
- **stale-hunter:** live process behavior. Received handoff: yote ralph-dashboard uvicorn PID 1781869 spinning one thread at ~67% CPU inside `os.walk` → `app/projects/discovery.py:32` `discover_project_paths`, zero client traffic on :8420 — suspect overly broad `PROJECT_DIRS` root causing repeated full-tree rescans. Root-caused via py-spy 2026-09-20; live diagnosis + fix is theirs.

Related: `docs/fleet-knowledgebase.md` §2 (Active crews) · `projects/ops/bin/runner-audit.sh` (runner lane, OS-level) · `hatch/bin/error_claims.py` (shared error-claim catalog) · `hatch/bin/agent-reaper --classify-errors` (harvest→classify) · master README `/home/toxic/sovereign/README.md`.

## Contribute

Severity assignments live in the shared catalog (`hatch/bin/error_claims.py`). New claims need observed evidence, not theory — cite the observation, the probe that refuted/confirmed it, and the safe path before adding one.
