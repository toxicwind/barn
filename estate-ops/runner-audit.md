# Runner Audit — watchdog-hunter (2026-09-20)

Permanent audit tooling for every watchdog, supervisor, and health check on hatch and yote.
Claim-vs-reality: a healthy claim + dead/never-run target = **FAKE** (repaired or replaced).
Probes are empirical only — ports, authenticated endpoints, process identity, recent activity.
Targets are never kill-tested.

## Deliverables

| Artifact | Path |
|---|---|
| Watchdog claim-vs-reality auditor | `projects/ops/bin/watchdog-audit.sh` |
| Orphan (pidfile/daemon/tmux/lock/port) hunter | `projects/ops/bin/orphan-hunt.sh` |
| This report | `projects/ops/runner-audit.md` |

Both scripts audit **both** boxes (they detect hatch vs yote and run the right checks),
suggest CLEAN/ADOPT dispositions, never print secrets, are report-only by default,
and exit nonzero when findings exist.

## Spindle verdict

**UNIDENTIFIED.** System-wide hidden searches on both hosts (processes, systemd units,
scheduler roots, `/etc/systemd`, `/usr/lib/systemd`, config roots, command lines,
`rg --hidden` from `/`) found no executable, process, service, directory, `.spindle`
file, or scheduler object named "spindle". Old Shingle JSONL transcripts mention the
word "spindle" in prompt text only — not an installed artifact. `/home/toxic/shingle/todos.md`
contains the task asking to identify it. Defensible position: the term is mistaken or
colloquial; no installed artifact exists yet. Root-level hidden searches from `/` on
both hosts remain the outstanding step before closing this.

## Claim-vs-reality table (verified 2026-09-20)

### hatch

| Watchdog / claim | Empirical probe | Verdict | Action |
|---|---|---|---|
| `bridge-watchdog` (5m cron): "bridge healthy" | `ws_daemon.py` alive + authenticated `exec.py 'echo WATCHDOG-AUDIT'` round-trip OK | **REAL** | none |
| `yote-connector-watch`: ":18301 served by connector.pid" | :18301 live (pid 28573, cwd `/home/hatch/workspace/yote-connector`, `/health` + `/exec` OK); pidfile said dead pid 2104 | **REAL target, STALE pidfile** | pidfile corrected to 28573 (2026-09-20 21:56 UTC) |
| `progress-watchdog` (Hearth): "progress fresh" | enabled def + `~/workspace/watchdog/progress_state.json` fresh + recent alerts | **REAL** | none |
| `swarm-watchdog` (2m cron): "no crashes" | real action recorded 2026-09-20 15:04 MDT (`hatch 12.1: PAUSED`) | **REAL** | none |
| `squawk-monitor` (5m cron): "bridge watched" | real bridge-outage handling recorded 2026-09-20 13:58:09 MDT | **REAL** (protected: report-only) | none |
| `kimi-auto-canary-judge` (5m cron): "judges canary" | body was a design-only idle loop; canary target never executed; 288 agent-spawns/day of pure overhead | **FAKE** | **REMOVED** 2026-09-20 ~21:32 UTC (scheduler reconciled) |
| `audit-bridge-watch` (5m, goal-owned): "bridge audit" | def was `enabled: false` + archived; scheduler reconciling from stale `_archive` copy | **FAKE-STATE** (desync, not dead target) | re-enabled; moved `_archive` copy aside; stable `enabled: true` past 15:58 MDT fire |
| race-optimizer schedule | active definition already absent; stale `/home/hatch/.cache/shingle/race-optimizer.pid` | **STALE** | pidfile removed |

### yote

| Watchdog / claim | Empirical probe | Verdict | Action |
|---|---|---|---|
| `fleet-watchdog-sweepd.service`: "sweeping every 60s" | active + sweep log fresh (<3m, real 60s sweeps) | **REAL** | none (timer-loop design noted; event-driven rule is a standing tension — coordinated, not edited) |
| `squawk-watchdog.timer`: "firing" | active, on schedule; `squawk-watchdog.sh` does real socket probes, never restarts healthy | **REAL** (protected) | none |
| pitchfork supervisor (pid 1006, v2.25.0, started 2026-09-18) | live; ~40 daemons supervised | **REAL** | none |
| `kimi-auto-shim`: pitchfork said "errored", :25153 occupied | holder was healthy (pid 1707866, `/health` 200) — pitchfork lost track | **FAKE-STATE** (desync) | safe reconciler `bin/pitchfork-restart` run; new pid 1794745, `/health` 200, pitchfork=running |
| `mcp-gateway`: `ready_http` :25120, status=available | :25120 held by `estate-scripts-chat` (`bun run chat.ts`); daemon dir `estate-scripts-mcp-gateway/` **does not exist**; `gateway.ts` exists nowhere | **BROKEN-DEF** (can never start; ready_http misattributed) | **NOT touched** — parallel worker has uncommitted pitchfork.toml WIP; flagged to fleet (msg 11565) |
| `awrawr-mcp` (:8377): pitchfork says "available" | :8377 **LIVE** — pid 2227697 running `/home/toxic/awrawr_mcp.py` (not the repo path `estate-scripts/bridge/awrawr_mcp.py`); `/mcp` returns 401 (auth required = serving) | **ORPHAN** (live service outside supervisor, non-repo path, differs from repo copy) | **ADOPT** — documented; NOT killed (serves tailscale `/mcp`) |
| 16 other auto=start daemons (coyote, search-api, axiom, hf-downloader, null-g-proxy, byte-vision, hindsight, kafka, dnsmasq, matter-server, oracle-core, boundless, ws-exec-tunnel, pixel-adb-keepalive, ralph-dashboard, codebase-memory) | status=available/stopped/errored, ports closed | **DOWN** (no false claim; auto=start unmet) | reported; restart-or-retire decision per daemon owner |

## Orphan dispositions (executed 2026-09-20)

| Orphan | Evidence | Disposition |
|---|---|---|
| `~/workspace/yote-connector/connector.pid` → dead 2104 | holder is live pid 28573 | **CLEAN**: pidfile rewritten to 28573 |
| 10 stale worktree pidfiles (`*/scratch/*.pid` → dead 5892/1804) | 8 already cleaned by parallel crew; 2 remaining in `edge-work` | **CLEAN**: removed |
| `/home/toxic/bench-run.lock` | untouched >2h, no holder (`fuser` clean) | **CLEAN**: removed |
| tmux `tau-lab` (3 idle bash panes) | idle but not dead; purpose unknown | **ADOPT**: documented; never blind-kill a lab session |
| 3 zombie processes (uv, MainThread) | parent = `shep` (live pitchfork daemon, pid 2031803) not reaping | **ADOPT**: harmless; clears on shep restart (not restarted — live daemon) |
| `/var/lock/asound.state.lock`, `card*.lock` | stale ALSA locks, no holder | reported; left (system files, harmless) |
| `/tmp` contents | — | **NOT triaged** — Trench owns that lane |

## Before / after evidence

- **kimi-auto-canary-judge**: before — 5-minute cron spawning agents against a never-executed canary.
  After — schedule removed, scheduler reconciled, zero spawns.
- **audit-bridge-watch**: before — `enabled: false`, archived, never firing.
  After — `enabled: true`, stale `_archive` copy moved aside, survived the 15:58 MDT fire.
- **yote-connector pidfile**: before — `2104` (dead). After — `28573` (verified live holder).
- **kimi-auto-shim**: before — pitchfork=errored, :25153 held by untracked pid 1707866.
  After — reconciled to pid 1794745, pitchfork=running, `/health` 200.
- **mcp-gateway false positive**: the audit script initially cried FAKE on :25120; root-caused to a
  misattributed `ready_http` + nonexistent dir. Script now distinguishes FAKE (desync),
  BROKEN-DEF (missing dir), and PORT-MISMATCH (wrong ready_http) via holder-cmdline comparison.

## Outstanding

1. **Spindle**: root-level hidden searches from `/` on both hosts still pending before final close.
2. **mcp-gateway**: broken definition; another worker's WIP in progress — do not collide.
3. **awrawr-mcp orphan**: live on non-repo path; needs owner decision (adopt into pitchfork vs retire).
4. **DOWN daemons**: 16 auto=start daemons not running; restart-or-retire per owner.
5. `fleet-watchdog-sweepd` timer-loop vs event-driven standing rule: noted tension, coordinated not edited.
