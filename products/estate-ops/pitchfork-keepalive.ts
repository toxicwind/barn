/**
 * pitchfork-keepalive.ts — Bun-native supervisor keepalive for the estate
 * pitchfork control plane. Replaces the systemd unit
 * (~/.config/systemd/user/pitchfork.service) which previously owned
 * `pitchfork supervisor run --boot` + Restart=on-failure.
 *
 * Why: the estate is moving to a NO-systemd lifecycle. This program owns the
 * ONE thing systemd uniquely provided for the supervisor itself: crash-restart
 * with backoff, and durable boot (--boot re-registers every boot_start/auto
 * daemon). It is FaultProc-style: run the real `pitchfork supervisor run
 * --boot`, and on ANY non-zero / abnormal exit, relaunch it on a capped
 * exponential backoff. A single BPF/pidfile guard prevents split-brain (the
 * exact failure the runbook warns about with manual `pitchfork supervisor
 * start`).
 *
 * Pure-typed core (resolution, backoff schedule, spawn args) lives in
 * pitchfork-keepalive-lib.ts and is unit-tested there.
 */
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Bun spawn wrapper ($) is a single dep-free primitive we already rely on.
import {
  resolvePitchforkBin,
  backoffDelayMs,
  buildSupervisorArgv,
  lockPath,
} from "./pitchfork-keepalive-lib.ts";

const HOME = homedir();
const PIDFILE = lockPath(HOME);

/** Refuse to start if another keepalive already owns the lock (no split-brain). */
function acquireLock(): void {
  if (existsSync(PIDFILE)) {
    const existing = process.pid;
    console.error(
      `[pitchfork-keepalive] lock ${PIDFILE} already exists (another keepalive?). refusing to start (pid=${existing}).`,
    );
    process.exit(3);
  }
  writeFileSync(PIDFILE, String(process.pid), { encoding: "utf8" });
}

function releaseLock(): void {
  try {
    unlinkSync(PIDFILE);
  } catch {
    /* already gone */
  }
}

const BIN = resolvePitchforkBin(process.env, HOME);
if (!BIN) {
  console.error("[pitchfork-keepalive] no usable pitchfork binary found.");
  process.exit(127);
}

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => {
  releaseLock();
  process.exit(130);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(143);
});

const ARGV = buildSupervisorArgv(BIN);
let attempt = 0;

async function main(): Promise<void> {
  // Advertise what we're supervising; never print secret-bearing env.
  console.error(`[pitchfork-keepalive] supervising: ${ARGV.join(" ")}`);
  for (;;) {
    attempt += 1;
    const started = Date.now();
    const proc = Bun.spawn(ARGV, {
      cwd: process.env.ESTATE_ROOT ?? "/home/toxic/estate",
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const code = await proc.exited;
    const ranMs = Date.now() - started;

    if (code === 0) {
      // Clean exit (e.g. manual `pitchfork supervisor stop`): honor it.
      console.error(
        `[pitchfork-keepalive] supervisor exited 0 after ${ranMs}ms — not restarting (clean stop).`,
      );
      return;
    }
    const wait = backoffDelayMs(attempt);
    console.error(
      `[pitchfork-keepalive] supervisor exited code=${code ?? "null"} after ${ranMs}ms; restarting in ${wait}ms (attempt=${attempt}).`,
    );
    // Synchronous sleep; matching systemd RestartSec=10 cadence.
    await Bun.sleep(wait);
  }
}

void main().catch((err) => {
  console.error("[pitchfork-keepalive] fatal:", err);
  process.exit(1);
});
