/**
 * claim.ts — LaneClaim schema + validation for lane-verify.
 *
 * A LaneClaim is what a lane (or a scheduler) ASSERTS about a lane's state.
 * The verifier's entire job is to check that assertion against observed
 * evidence — never the other way around. An error string is a claim, not a
 * fact; a claimed "restarted"/"done" with zero observed activity is a
 * stalled lane, not a completed one.
 */

export type ClaimKind = "restarted" | "running" | "done";

export interface LaneClaim {
  /** Lane identifier, e.g. "wave4-router-max". */
  lane: string;
  /** What is being claimed about the lane. */
  claim: ClaimKind;
  /** ISO-8601 timestamp of when the claim was made. */
  claimed_at: string;
  /** Directories to scan for observed activity (absolute paths). */
  watch_dirs: string[];
  /**
   * Optional heartbeat file: a path whose mtime must stay fresh while the
   * lane claims "running". Borrowed from the GitHub-ranked "worker
   * heartbeat stall detection" pattern (pattern-borrow.ts: score 50.0,
   * 60,053 stars across 8 repos, test frac 0.75).
   */
  heartbeat_file?: string;
  /** Max age in seconds of the heartbeat before it counts as stale. Default 900. */
  heartbeat_window_s?: number;
  /** Seconds after claimed_at during which absence of evidence is tolerated. Default 300. */
  grace_s?: number;
  /** Checkpoint file to append verification events to (wave4 checkpoint schema). */
  checkpoint_file?: string;
  /** Free-form inputs recorded with the claim (for checkpoint context). */
  inputs?: Record<string, unknown>;
}

const CLAIM_KINDS: ClaimKind[] = ["restarted", "running", "done"];

export function parseClaim(raw: unknown): LaneClaim {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("claim must be a JSON object");
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.lane !== "string" || c.lane.length === 0) {
    throw new Error("claim.lane must be a non-empty string");
  }
  if (!CLAIM_KINDS.includes(c.claim as ClaimKind)) {
    throw new Error(`claim.claim must be one of ${CLAIM_KINDS.join("|")}`);
  }
  if (typeof c.claimed_at !== "string" || Number.isNaN(Date.parse(c.claimed_at))) {
    throw new Error("claim.claimed_at must be a valid ISO-8601 timestamp");
  }
  if (!Array.isArray(c.watch_dirs) || c.watch_dirs.some((d) => typeof d !== "string")) {
    throw new Error("claim.watch_dirs must be an array of strings");
  }
  if (c.heartbeat_file !== undefined && typeof c.heartbeat_file !== "string") {
    throw new Error("claim.heartbeat_file must be a string");
  }
  if (c.heartbeat_window_s !== undefined && typeof c.heartbeat_window_s !== "number") {
    throw new Error("claim.heartbeat_window_s must be a number");
  }
  if (c.grace_s !== undefined && typeof c.grace_s !== "number") {
    throw new Error("claim.grace_s must be a number");
  }
  if (c.checkpoint_file !== undefined && typeof c.checkpoint_file !== "string") {
    throw new Error("claim.checkpoint_file must be a string");
  }
  return {
    lane: c.lane,
    claim: c.claim as ClaimKind,
    claimed_at: c.claimed_at,
    watch_dirs: c.watch_dirs,
    heartbeat_file: c.heartbeat_file,
    heartbeat_window_s: c.heartbeat_window_s ?? 900,
    grace_s: c.grace_s ?? 300,
    checkpoint_file: c.checkpoint_file,
    inputs: (c.inputs as Record<string, unknown>) ?? {},
  };
}
