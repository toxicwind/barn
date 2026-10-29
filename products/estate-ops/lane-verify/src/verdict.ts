/**
 * verdict.ts — deterministic, evidence-grounded lane verdicts.
 *
 * Implements the hardened wave4 retry protocol as code:
 *   - a lane claimed "restarted"/"running"/"done" with no observed tool
 *     calls, files, or test output after the claim counts as STALLED;
 *   - a stalled lane is rolled back to its checkpoint and REROUTED, never
 *     reported as done;
 *   - verdicts are computed from cited evidence items only — a rule with no
 *     evidence ref is not a passing rule (evidence-grounded scoring, after
 *     arXiv:2601.08654 "From Rubrics to Reliable Scores").
 *
 * Fail-closed: any evidence-gathering failure yields STALLED with an
 * explicit note — we never verify on unknown state.
 */
import type { LaneClaim } from "./claim.ts";
import {
  gatherAll,
  type EvidenceItem,
} from "./evidence.ts";

export type VerdictKind = "PROGRESSING" | "STALLED" | "DONE_VERIFIED";

export interface RuleResult {
  rule: string;
  passed: boolean;
  /** Evidence refs this rule's outcome rests on. Empty on failure is fine. */
  evidence_refs: string[];
  note: string;
}

export interface RerouteSpec {
  reason: string;
  checkpoint_ref: string | null;
  /** Concrete next step — never "retry the same call". */
  suggested_route: string;
}

export interface LaneVerdict {
  lane: string;
  claim: LaneClaim["claim"];
  verdict: VerdictKind;
  verified_at: string;
  evidence: EvidenceItem[];
  rules: RuleResult[];
  reroute: RerouteSpec | null;
}

function hasActivitySince(evidence: EvidenceItem[], since: Date): EvidenceItem[] {
  return evidence.filter(
    (e) => e.kind !== "heartbeat" && new Date(e.observed_at) >= since,
  );
}

export function judge(claim: LaneClaim, now: Date = new Date()): LaneVerdict {
  const rules: RuleResult[] = [];
  let evidence: EvidenceItem[] = [];
  let gatherError: string | null = null;

  const claimedAt = new Date(claim.claimed_at);
  const graceMs = (claim.grace_s ?? 300) * 1000;
  const inGrace = now.getTime() - claimedAt.getTime() < graceMs;

  // R1 — the claim itself is well-formed and not from the future.
  const r1ok = claimedAt.getTime() <= now.getTime() + 60_000;
  rules.push({
    rule: "claim-wellformed",
    passed: r1ok,
    evidence_refs: [],
    note: r1ok
      ? `claim at ${claim.claimed_at} precedes verification`
      : `claimed_at ${claim.claimed_at} is in the future — clock skew or bad claim`,
  });

  // Gather evidence (observed state only).
  try {
    evidence = gatherAll(claim.watch_dirs, claimedAt, claim.heartbeat_file);
  } catch (err) {
    gatherError = err instanceof Error ? err.message : String(err);
  }

  const activity = hasActivitySince(evidence, claimedAt);
  const activityRefs = activity.map((e) => e.ref);

  // R2 — observed activity after the claim.
  const r2ok = gatherError === null && activity.length > 0;
  rules.push({
    rule: "observed-activity",
    passed: r2ok,
    evidence_refs: activityRefs,
    note:
      gatherError !== null
        ? `evidence gathering failed: ${gatherError} — failing closed`
        : activity.length > 0
          ? `${activity.length} observed activit${activity.length === 1 ? "y" : "ies"} at/after claim`
          : `zero files, commits, or receipts observed at/after ${claim.claimed_at}`,
  });

  // R3 — heartbeat freshness (only when the claim uses a heartbeat).
  let r3ok = true;
  if (claim.heartbeat_file) {
    const hb = evidence.find((e) => e.kind === "heartbeat");
    const windowMs = (claim.heartbeat_window_s ?? 900) * 1000;
    if (!hb) {
      r3ok = false;
      rules.push({
        rule: "heartbeat-fresh",
        passed: false,
        evidence_refs: [],
        note: `heartbeat file ${claim.heartbeat_file} unreadable or missing`,
      });
    } else {
      const ageMs = now.getTime() - new Date(hb.observed_at).getTime();
      r3ok = ageMs <= windowMs;
      rules.push({
        rule: "heartbeat-fresh",
        passed: r3ok,
        evidence_refs: [hb.ref],
        note: r3ok
          ? `heartbeat age ${(ageMs / 1000).toFixed(0)}s within window ${(windowMs / 1000).toFixed(0)}s`
          : `heartbeat stale: age ${(ageMs / 1000).toFixed(0)}s exceeds window ${(windowMs / 1000).toFixed(0)}s`,
      });
    }
  }

  // R4 — a "done" claim requires artifacts, not just activity prose.
  let r4ok = true;
  if (claim.claim === "done") {
    const artifacts = activity.filter((e) => e.kind === "file" || e.kind === "commit");
    r4ok = artifacts.length > 0;
    rules.push({
      rule: "done-requires-artifacts",
      passed: r4ok,
      evidence_refs: artifacts.map((e) => e.ref),
      note: r4ok
        ? `${artifacts.length} artifact(s) back the done claim`
        : `claimed "done" with zero observed artifacts — the exact claimed-restart-did-nothing bug`,
    });
  }

  // Verdict.
  let verdict: VerdictKind;
  let reroute: RerouteSpec | null = null;
  if (gatherError !== null) {
    verdict = "STALLED";
  } else if (claim.claim === "done" && r1ok && r2ok && r4ok) {
    verdict = "DONE_VERIFIED";
  } else if (claim.claim !== "done" && r1ok && r2ok && r3ok && !inGrace) {
    verdict = "PROGRESSING";
  } else if (claim.claim !== "done" && r1ok && r2ok && r3ok && inGrace) {
    // Inside the grace window with activity already observed: progressing.
    verdict = "PROGRESSING";
  } else {
    verdict = "STALLED";
  }

  if (verdict === "STALLED") {
    const failed = rules.filter((r) => !r.passed).map((r) => r.rule);
    reroute = {
      reason: `lane "${claim.lane}" claimed "${claim.claim}" at ${claim.claimed_at} but failed rules: ${failed.join(", ") || "unknown"}`,
      checkpoint_ref: claim.checkpoint_file ?? null,
      suggested_route:
        "roll back partial effects to the checkpointed state, confirm the rollback by direct observation, then redo through a different legitimate route — never hot-loop the same failing call",
    };
  }

  return {
    lane: claim.lane,
    claim: claim.claim,
    verdict,
    verified_at: now.toISOString(),
    evidence,
    rules,
    reroute,
  };
}
