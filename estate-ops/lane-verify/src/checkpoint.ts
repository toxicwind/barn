/**
 * checkpoint.ts — refusal-routing checkpoint appends.
 *
 * The wave4 protocol requires: BEFORE retrying anything, append the full
 * current state (lane, step, inputs, exact error text, direct observations,
 * timestamp) to the checkpoint file. This module writes events in the exact
 * schema of ~/workspace/six-task-loop/wave4-refusal-checkpoint.json so
 * lane-verify verdicts feed the same ledger the schedulers read.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";

export interface CheckpointEvent {
  at: string;
  lane: string;
  kind: string;
  step?: string;
  inputs?: unknown;
  error_text?: string;
  observation?: string;
  detail?: string;
  result?: string;
  verified_by?: string;
}

/**
 * Append an event to a checkpoint file, creating `{events: []}` if absent.
 * Atomic: write temp + rename. Returns the event as written.
 */
export function appendCheckpointEvent(
  checkpointFile: string,
  event: Omit<CheckpointEvent, "at"> & { at?: string },
): CheckpointEvent {
  const full: CheckpointEvent = {
    at: event.at ?? new Date().toISOString(),
    ...event,
  };
  let doc: { events: CheckpointEvent[] };
  try {
    const raw = readFileSync(checkpointFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    doc = { events: Array.isArray(parsed.events) ? parsed.events : [] };
    // Preserve any other top-level keys the file already carries.
    for (const [k, v] of Object.entries(parsed)) {
      if (k !== "events") (doc as Record<string, unknown>)[k] = v;
    }
  } catch {
    doc = { events: [] };
  }
  doc.events.push(full);
  const tmp = join(tmpdir(), `${basename(checkpointFile)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, checkpointFile);
  void dirname;
  return full;
}

/** Build the canonical verify-event for a lane-verify verdict. */
export function verifyEventFor(
  lane: string,
  verdict: string,
  failedRules: string[],
  evidenceCount: number,
): Omit<CheckpointEvent, "at"> {
  return {
    lane,
    kind: "lane-verify.verdict",
    step: "claim-vs-evidence verification",
    observation: `verdict=${verdict}; failed_rules=[${failedRules.join(", ")}]; evidence_items=${evidenceCount}`,
    result: verdict,
    verified_by: "projects/ops/lane-verify (observed effects only)",
  };
}
