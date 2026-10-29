# RUNNERS.md — task runner / scheduler inventory

Audited 2026-09-20 ~15:20 MDT by runner-auditor (ember). Every verdict has a
command output behind it. Read, don't guess.

## hatch (this cell)

All schedulers here are Hatch `cron.*` jobs (interval/daily kinds), not
system crontab — hatch has no crontab and no systemd user units. 34 enabled
jobs; status at audit time: 2 running, 0 queued.

| job | sched | alive? | claims | reality (last runs) | verdict |
|---|---|---|---|---|---|
| `bridge-watchdog` | 5m | yes | keep Hatch↔Yote WS bridge healthy, circuit-break on 401 | succeeded 15:13 MDT, silent on success | HEALTHY |
| `yote-connector-watch` | 5m | yes | keep cell listener :18301 alive; no restart-spam during 401 | succeeded; 15:06 manual run saw :18301 refused → recovered by 15:11 | HEALTHY |
| `squawk-monitor` | 5m | yes | surface new fleet messages, skip on 401 sentinel | enabled, recent runs clean | HEALTHY |
| `swarm-watchdog` | 5m | yes | crash-prevention interlock: pause swarm when hatch load1>10 | FIRED 15:04 (load 12.1 → PAUSED); still paused at 11.7 — by design, alerted via squawk itself | HEALTHY |
| `progress-watchdog` (Hearth) | 3m | yes | supervise oracle-market, ledger, bidders, pitchfork daemons, bridge; welcome fleet agents; 30m PULSE | succeeding, rich ALERT/WELCOMED/PULSE output; one failed run 15:04 (service restart mid-exec, one-off) | HEALTHY |
| `kimi-auto-canary-judge` | 5m | yes | judge kimi-auto canary phases | succeeding, phase=0 idle ("HOLD — no active canary"). 5m ticks while idle are by design — verdict only on phase change | HEALTHY |
| `heartbeat` | 30m | yes | heartbeat | skipped: no HEARTBEAT.md instructions | HEALTHY (no-op by design) |
| `agentic-feature-tour` | daily 10:52 | yes | system feature tour | enabled | HEALTHY |
| `deterministic-doctor` | 1h (system) | yes | deterministic doctor | succeeded 15:00, `{"results":[]}` — nothing to report, sane | HEALTHY |
| `feed-pulse-00..23` | 24× daily (system) | yes | feed pulse | feed-pulse-15 succeeded 15:13 ("admitted") | HEALTHY |
| `profile-image` | 168h (system) | yes | weekly profile image | enabled | HEALTHY |

How to check any of them: `cron.status` (scheduler-wide), `cron.runs id=<job>`.
System jobs (is_system=true) cannot be disabled/removed via the cron tool.

## yote (bridge box, 16 cores / 62G)

No crontab on yote (binary absent). Schedulers are: pitchfork supervisor,
systemd user units + timers, and yote-conn exec calls from hatch crons.
(deep yote audit belongs to yote-task-runner-auditor — sibling worker, same
mission; don't stomp, coordinate in fleet.)

| runner | box | alive? | claims | reality | verdict |
|---|---|---|---|---|---|
| pitchfork supervisor | yote | yes | run ~53 estate-scripts/* daemons | `pitchfork list`: 51/51 `running` | HEALTHY |
| `fleet-watchdog-sweepd.service` | yote (systemd user) | yes | fleet presence + rollover sweeper, 60s loop, lane-7 | running; distinct from Hearth's progress-watchdog (presence heartbeat vs supervisor) — NOT a dupe | HEALTHY |
| `squawk-watchdog.timer` | yote (60s) | yes | squawk-ws + squawk-feed liveness | fired 15:18:07 (9s before check) | HEALTHY |
| `depend-refire.timer` | yote (60s) | yes | restart pitchfork-stopped daemons when deps healthy | fired 15:18:07 | HEALTHY |
| `awrawr-mcp` (awrawr-ws-exec) | yote (systemd user) | yes | the MCP exec bridge on :8379 | running | HEALTHY |
| `phone-lane-keeper`, `phone-vitals` | yote (systemd user) | yes | Pixel ADB self-healing + telemetry | running | HEALTHY |
| `ralph-dashboard` | yote (systemd user) | yes | uvicorn :8420 | running | HEALTHY |
| `quickshell-ii` | yote (systemd user) | yes | desktop shell (estate-scripts/projects/shell) | running | HEALTHY |
| `awrawr-mcp-audit-export.timer` | yote (daily 00:00) | yes | nightly audit export | last fired 15h ago | HEALTHY |
| `refusal-hunt-nightly.timer` | yote (daily 03:00) | yes | nightly refusal hunt | last fired 12h ago | HEALTHY |
| `gemini-sdk-refresh.timer` | yote (2× daily) | yes | SDK refresh | last fired 11h ago | HEALTHY |
| oracle-market (`oracle_loop.py` + `market_watchdog.py` + 2 bidders) | yote (pitchfork) | yes | intake auction market; watchdog restarts bidders only after 3 consecutive silent closes | running (oracle_loop etime ~2h, bidders ~6.6h); watchdog is **inotify on the ledger, no polling** — event-driven, good | HEALTHY — oracle crew's live work, do not touch |
| tmux: `tau-hyperfix`, `tau-lab` | yote | n/a | transient agent work sessions | created 15:10/15:12 today | not runners, ignore |

**Flag (not a fix):** `driver.sh`/`supervise.sh` (fleet-watchdog 2m platform
supervisor) has no scheduler entry on hatch referencing it — the 2m platform
cron appears migrated into the systemd unit + Hearth's alert path. Legacy
entry point only; do not delete until sweepd's supervisor story is confirmed
with its owner.

**NOT duplicates (verified, keep both):** progress-watchdog (hatch, 3m,
market/ledger/daemon supervision + fleet social) vs fleet-watchdog-sweepd
(yote, 60s, presence heartbeat); bridge-watchdog vs yote-connector-watch;
progress-watchdog vs estate-scripts/market-watchdog (latter is inotify-driven,
bidder-only).

**Kills:** none — no two runners do the same job, nothing was wedged.

## Findings + fixes applied (2026-09-20, this audit)

1. **ralph-dashboard.service BROKEN → FIXED.** Root cause: backend venv
   site-packages corrupted (`uvicorn._types` missing; even pip broken).
   Restart counter at 53812. Fix: rebuilt venv from
   `requirements.txt`, added the missing genuine dependency
   `psutil>=7.0,<8.0` (imported by `app/system/service.py`, never pinned),
   deleted the corrupt venv backup deliberately. Service `active`,
   `/health` 200. Durable: files on disk. Caveat: `/home/toxic/ralph-dashboard`
   is NOT a git repo — its owner should integrate it into the rightful repo.
2. **Stale cron def `race-optimizer-watchdog` REMOVED (recoverable trash).**
   Created 2026-09-20 06:23, its body revives `race-optimizer.py` — the
   recompute-every-60s CPU hog the Architect ordered killed (see AGENTS.md). The
   scheduler never registered the job, so trashing the file was clean.
3. **swarm still PAUSED at load1 ~10** — circuit breaker doing its job, not a
   failure.
4. Fleet-watchdog 2m platform `driver.sh`/`supervise.sh` has no scheduler
   entry on hatch — legacy entry point; covered by the systemd unit + Hearth's
   alert path. Do not delete until confirmed with its owner.

Permanent audit script: `projects/ops/bin/runner-audit.sh` (this repo).
Run it on demand; it exits nonzero on findings. First run post-fix: clean,
exit 0.

## Notes

- System cron jobs (feed-pulse ×24, deterministic-doctor, profile-image) run
  ~96+ background agent runs/day before any user chat; cannot be managed via
  the cron tool.
- swarm-watchdog is the circuit breaker per standing directive — hatch load1
  12.1 at 15:04 triggered a real auto-pause; still paused at 11.7. That is
  correct behavior, not a failure.
- Every fix here must live in real files and survive a full bridge restart /
  yote reboot (durability rule). No monkeypatching was needed.
