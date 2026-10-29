#!/usr/bin/env bun
/**
 * pitchfork-restart.ts — Bun-native drop-in replacement for the legacy bash
 * bin/pitchfork-restart. Per-daemon: stop (TERM/30s -> KILL/10s), sweep stale
 * lock files the daemon held, start, then verify Status: running.
 *
 * Pure decision logic (status parsing, lock classification, sweep labels,
 * reap planning) lives in pitchfork-restart-lib.ts and is unit-tested there.
 * This wrapper owns all I/O: spawning the estate pitchfork shim, reading
 * /proc/<pid>/fd, fuser holder discovery, and TERM/KILL signaling.
 */
import { readdirSync, readlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  STOP_TIMEOUT,
  KILL_TIMEOUT,
  START_SETTLE_SECONDS,
  parseStatusPid,
  hasRunningStatus,
  daemonLockFiles,
  sweepRoundLabel,
  initialSweepLabel,
} from "./pitchfork-restart-lib.ts";

/** Default estate dispatch shim; PITCHFORK_BIN overrides it (matches bash). */
function pfBin(env: Record<string, string | undefined>): string {
  return env.PITCHFORK_BIN?.trim() || "/home/toxic/pens/barn/estate-ops/pitchfork";
}

function log(msg: string): void {
  process.stderr.write(`[pitchfork-restart] ${msg}\n`);
}
function die(msg: string): never {
  log(`FATAL: ${msg}`);
  process.exit(1);
}

/** Run a command to completion, capturing stdout; stderr ignored. */
function runCapture(argv: string[]): { ok: boolean; stdout: string } {
  const res = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
  return {
    ok: res.exitCode === 0,
    stdout: (res.stdout?.toString?.() ?? "") as string,
  };
}

function daemonPid(pf: string, id: string): string | null {
  const { stdout } = runCapture([pf, "status", id]);
  return parseStatusPid(stdout);
}

/** Snapshot the daemon's open lock files via /proc/<pid>/fd (bash `daemon_locks`). */
function daemonLocks(pid: string): string[] {
  const fdDir = `/proc/${pid}/fd`;
  let entries: string[];
  try {
    entries = readdirSync(fdDir);
  } catch {
    return [];
  }
  const fds = entries.map((fd) => {
    let target: string | null = null;
    try {
      target = readlinkSync(join(fdDir, fd));
    } catch {
      target = null;
    }
    return { fd, target };
  });
  return daemonLockFiles(fds, (p) => existsSync(p));
}

/** Poll `kill -0` until the pid disappears or the timeout (seconds) elapses. */
function waitPidGone(pid: string, timeoutSec: number): boolean {
  for (let i = 0; i < timeoutSec; i++) {
    if (!pidAlive(pid)) return true;
    Bun.sleepSync(1000);
  }
  return !pidAlive(pid);
}

function pidAlive(pid: string): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // ESRCH => gone; EPERM => alive but not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Numerically parse `fuser <lock>` output into a holder pid list. */
function fuserHolders(lock: string): string[] {
  const res = Bun.spawnSync(["fuser", lock], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (res.stdout?.toString?.() ?? "") as string;
  const holders: string[] = [];
  for (const tok of out.trim().split(/\s+/)) {
    if (/^[0-9]+$/.test(tok)) holders.push(tok);
  }
  return holders;
}

/**
 * Sweep one lock file. Mirrors bash `sweep_lock`: TERM holders, wait 2s,
 * KILL survivors, wait 1s, recheck; delete stale. Returns the bash status
 * label and whether a holder survived (rc signal).
 */
function sweepLock(lock: string): { label: string; survived: boolean } {
  if (!existsSync(lock)) {
    return { label: `${initialSweepLabel(false)} ${lock}`, survived: false };
  }
  let holders = fuserHolders(lock);
  if (holders.length === 0) {
    const removed = tryRemove(lock);
    return {
      label: `${removed ? "deleted-stale" : "delete-failed"} ${lock}`,
      survived: false,
    };
  }
  for (const h of holders) {
    log(`orphan holder pid=${h} on ${lock} -> SIGTERM`);
    signal(h, "SIGTERM");
  }
  Bun.sleepSync(2000);
  for (const h of holders) {
    if (pidAlive(h)) {
      log(`orphan holder pid=${h} survived TERM -> SIGKILL`);
      signal(h, "SIGKILL");
    }
  }
  Bun.sleepSync(1000);
  holders = fuserHolders(lock);
  if (holders.length === 0) {
    const removed = tryRemove(lock);
    return {
      label: `${removed ? "deleted-after-reap" : "delete-failed"} ${lock}`,
      survived: false,
    };
  }
  return { label: sweepRoundLabel(lock, holders), survived: true };
}

function tryRemove(lock: string): boolean {
  try {
    rmSync(lock, { force: true });
    return true;
  } catch {
    return false;
  }
}

function signal(pid: string, sig: "SIGTERM" | "SIGKILL"): void {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  try {
    process.kill(n, sig);
  } catch {
    /* ignore ESRCH */
  }
}

function restartOne(pf: string, id: string): number {
  let rc = 0;
  log(`=== restart ${id} ===`);
  const pid = daemonPid(pf, id);
  if (!pid || pid === "0") {
    log(`${id}: no live PID (already stopped?) — sweeping nothing, starting`);
  } else {
    log(`${id}: pid=${pid}, snapshotting open lock files`);
    const locks = daemonLocks(pid);
    if (locks.length > 0) {
      log(`${id}: tracked locks:`);
      for (const l of locks) log(`  ${l}`);
    }
    log(`${id}: stopping`);
    runCapture([pf, "stop", id]);
    if (waitPidGone(pid, STOP_TIMEOUT)) {
      log(`${id}: pid=${pid} exited`);
    } else {
      log(`${id}: pid=${pid} would not stop in ${STOP_TIMEOUT}s -> SIGKILL`);
      signal(pid, "SIGKILL");
      if (!waitPidGone(pid, KILL_TIMEOUT)) {
        die(`${id}: pid=${pid} unkillable, refusing to continue`);
      }
    }
    if (locks.length > 0) {
      log(`${id}: sweeping locks for stale locks`);
      for (const lockfile of locks) {
        const { label, survived } = sweepLock(lockfile);
        log(`${id}: lock ${label}`);
        if (survived) rc = 1;
      }
    }
  }
  log(`${id}: starting`);
  const start = runCapture([pf, "start", id]);
  if (!start.ok) die(`${id}: start failed`);
  Bun.sleepSync(START_SETTLE_SECONDS * 1000);
  const { stdout } = runCapture([pf, "status", id]);
  if (hasRunningStatus(stdout)) {
    log(`${id}: running`);
  } else {
    die(`${id}: not running after start`);
  }
  return rc;
}

function main(argv: string[]): void {
  const pf = pfBin(process.env);
  let rc = 0;
  for (const id of argv) {
    try {
      if (restartOne(pf, id) !== 0) rc = 1;
    } catch (err) {
      log(`FATAL during ${id}: ${err}`);
      rc = 1;
    }
  }
  process.exit(rc);
}

const ids = process.argv.slice(2);
void Promise.resolve().then(() => main(ids));
