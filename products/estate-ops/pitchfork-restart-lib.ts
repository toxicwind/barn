/**
 * pitchfork-restart-lib.ts — pure, typed core of the estate daemon restart tool
 * (bin/pitchfork-restart.ts). No side effects at import time; the decision
 * logic is unit-tested in pitchfork-restart-lib.test.ts.
 *
 * It reproduces the semantics of the legacy bash bin/pitchfork-restart:
 *   stop -> TERM / wait 30s -> KILL / wait 10s
 *   sweep the daemon's open lock files (fuser-aware)
 *   start -> wait 2s -> verify Status: running
 *
 * Only the purely-computable pieces are lifted here (status-line parsing, lock
 * target classification, wait/sweep decision logic). I/O (spawning pitchfork,
 * reading /proc/<pid>/fd, fuser, kill) lives in the CLI wrapper so every branch
 * here is testable deterministically.
 */
/** Seconds to wait for a clean TERM stop before SIGKILL (matches bash). */
export const STOP_TIMEOUT = 30;
/** Seconds to wait after SIGKILL before refusing to continue (matches bash). */
export const KILL_TIMEOUT = 10;
/** Seconds to sleep after `start` before verifying Status: running. */
export const START_SETTLE_SECONDS = 2;
/** Description printed by the bash sweep for an already-absent lock. */
export const SWEEP_ABSENT_PREFIX = "absent ";
/** Description printed by the bash sweep after a stale lock is removed. */
export const SWEEP_DELETED_STALE_PREFIX = "deleted-stale ";
export const SWEEP_DELETED_AFTER_REAP_PREFIX = "deleted-after-reap ";
export const SWEEP_DELETE_FAILED_PREFIX = "delete-failed ";
export const SWEEP_HOLDER_SURVIVED_PREFIX = "holder-survived ";

/** Extract a live pid from `pitchfork status <name>` output. */
export function parseStatusPid(statusOutput: string): string | null {
  for (const line of statusOutput.split("\n")) {
    if (!line.startsWith("PID:")) continue;
    const field = line.slice("PID:".length).trim();
    if (!field) return null;
    return field.split(/\s+/)[0];
  }
  return null;
}

/** True when `pitchfork status <name>` reports the daemon running. */
export function hasRunningStatus(statusOutput: string): boolean {
  for (const line of statusOutput.split("\n")) {
    if (
      line.startsWith("Status:") &&
      line.slice("Status:".length).trim().split(/\s+/)[0] === "running"
    ) {
      return true;
    }
  }
  return false;
}

/** True when a /proc/<pid>/fd symlink points at a real lock file worth tracking. */
export function isLockTarget(
  target: string,
  isFile: (path: string) => boolean,
): boolean {
  const lower = target.toLowerCase();
  if (!(lower.endsWith(".lock") || lower.endsWith(".lck"))) return false;
  if (target.includes("(deleted)")) return false;
  return isFile(target);
}

/**
 * Enumerate the lock files a daemon currently holds, given its open fds.
 * `readlink` is the /proc/<pid>/fd/* -> path mapping (target null = unreadable).
 * Returns the deduplicated list of real lock files to sweep.
 */
export function daemonLockFiles(
  fds: Array<{ fd: string; target: string | null }>,
  isFile: (path: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const locks: string[] = [];
  for (const entry of fds) {
    if (!entry.target) continue;
    if (!isLockTarget(entry.target, isFile)) continue;
    if (seen.has(entry.target)) continue;
    seen.add(entry.target);
    locks.push(entry.target);
  }
  return locks;
}

/**
 * Decide whether a lock sweep is needed at all. Mirrors the bash: an absent
 * lock needs no work (returns the "absent" label); a present one must be
 * swept for holders.
 */
export function initialSweepLabel(lockExists: boolean): string {
  return lockExists ? "pending" : SWEEP_ABSENT_PREFIX.trim();
}

/**
 * Pure decision for one sweep round given the surviving holder set.
 * Mirrors the bash `sweep_lock` return strings:
 *  - no holders after reaping -> delete stale -> "deleted-after-reap <lock>"
 *  - holders survived TERM/KILL -> "holder-survived <lock> holders=<...>"
 */
export function sweepRoundLabel(
  lockPath: string,
  holdersNow: string[],
): string {
  if (holdersNow.length === 0) {
    return `${SWEEP_DELETED_AFTER_REAP_PREFIX}${lockPath}`;
  }
  return `${SWEEP_HOLDER_SURVIVED_PREFIX}${lockPath} holders=${holdersNow.join(",")}`;
}

/** Model of the two-phase orphan reaping (TERM then KILL) — pure scheduling. */
export type ReapPlan = { term: string[]; killAfter2s: string[] };

/** Split holders into TERM-first then KILL-if-alive, matching the bash 2s/1s cadence. */
export function planReap(holders: string[]): ReapPlan {
  return { term: [...holders], killAfter2s: [...holders] };
}
