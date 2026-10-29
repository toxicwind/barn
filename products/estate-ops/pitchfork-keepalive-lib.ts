/**
 * pitchfork-keepalive-lib.ts — pure, typed core of the estate supervisor
 * keepalive (pitchfork-keepalive.ts). No side effects at import time; all
 * decision logic is unit-tested in pitchfork-keepalive-lib.test.ts.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pitchforkCandidates } from "./pitchfork-lib.ts";

/** Cap on backoff between supervisor crash-restarts (matches systemd RestartSec spirit). */
export const MAX_BACKOFF_MS = 60_000;
/** Base backoff; a healthy fast crash-restart cadence. */
export const BASE_BACKOFF_MS = 10_000;

/**
 * Exponential backoff with a hard cap and a small reset on long uptime.
 * @param attempt  1-based attempt counter (1 = first relaunch).
 * @returns delay in ms before relaunching.
 */
export function backoffDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS);
  return exp;
}

/**
 * Resolve the first existing pitchfork binary, honoring an explicit override.
 * The candidate set is the canonical mise-first one from pitchfork-lib.ts
 * (single source of truth — no drift between the dispatcher and keepalive).
 */
export function resolvePitchforkBin(
  env: Record<string, string | undefined>,
  home = process.env.HOME ?? "/home/toxic",
): string | null {
  if (env.PITCHFORK_BIN && env.PITCHFORK_BIN.trim()) return env.PITCHFORK_BIN;
  for (const candidate of pitchforkCandidates(home)) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Build the argv for `pitchfork supervisor run --boot`. */
export function buildSupervisorArgv(bin: string): string[] {
  return [bin, "supervisor", "run", "--boot"];
}

/** The lock file path used to guarantee single-keepalive (no split-brain). */
export function lockPath(home: string): string {
  return join(home, ".local/state/pitchfork/keepalive.lock");
}
