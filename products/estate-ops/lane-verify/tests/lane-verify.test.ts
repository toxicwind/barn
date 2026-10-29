/**
 * lane-verify tests — run with `bun test` from projects/ops/lane-verify/.
 *
 * Every test constructs REAL filesystem state (files with real mtimes) and
 * runs the real judge() over it. No mocks of the thing under test.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseClaim } from "../src/claim.ts";
import { judge } from "../src/verdict.ts";
import { appendCheckpointEvent } from "../src/checkpoint.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-verify-test-"));
});

function claimAt(minutesAgo: number, overrides: Record<string, unknown> = {}) {
  return parseClaim({
    lane: "test-lane",
    claim: "restarted",
    claimed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    watch_dirs: [dir],
    ...overrides,
  });
}

function touch(name: string, minutesAgo: number): string {
  const p = join(dir, name);
  writeFileSync(p, `content ${Date.now()}`);
  const t = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(p, t, t);
  return p;
}

describe("verdicts", () => {
  test("zero activity after claim -> STALLED with reroute", () => {
    const v = judge(claimAt(30));
    expect(v.verdict).toBe("STALLED");
    expect(v.reroute).not.toBeNull();
    expect(v.reroute!.reason).toContain("test-lane");
    const failed = v.rules.filter((r) => !r.passed).map((r) => r.rule);
    expect(failed).toContain("observed-activity");
  });

  test("file written after claim -> PROGRESSING", () => {
    touch("work.txt", 5); // 5 min ago
    const v = judge(claimAt(30, { claim: "running" }));
    expect(v.verdict).toBe("PROGRESSING");
    expect(v.reroute).toBeNull();
    const r2 = v.rules.find((r) => r.rule === "observed-activity")!;
    expect(r2.passed).toBe(true);
    expect(r2.evidence_refs.length).toBeGreaterThan(0);
  });

  test("done claim with artifacts -> DONE_VERIFIED", () => {
    touch("result.txt", 5);
    const v = judge(claimAt(30, { claim: "done" }));
    expect(v.verdict).toBe("DONE_VERIFIED");
  });

  test("done claim with zero activity -> STALLED (the claimed-done-did-nothing bug)", () => {
    const v = judge(claimAt(30, { claim: "done" }));
    expect(v.verdict).toBe("STALLED");
    const failed = v.rules.filter((r) => !r.passed).map((r) => r.rule);
    expect(failed).toContain("done-requires-artifacts");
    expect(v.reroute!.suggested_route).toContain("roll back");
  });

  test("stale heartbeat with running claim -> STALLED", () => {
    const hb = touch("heartbeat", 40); // 40 min old
    const v = judge(
      claimAt(30, { claim: "running", heartbeat_file: hb, heartbeat_window_s: 900 }),
    );
    expect(v.verdict).toBe("STALLED");
    const r3 = v.rules.find((r) => r.rule === "heartbeat-fresh")!;
    expect(r3.passed).toBe(false);
    expect(r3.evidence_refs.length).toBe(1); // the stale heartbeat itself is the evidence
  });

  test("fresh heartbeat + activity -> PROGRESSING", () => {
    const hb = touch("heartbeat", 2);
    touch("work.txt", 5);
    const v = judge(
      claimAt(30, { claim: "running", heartbeat_file: hb, heartbeat_window_s: 900 }),
    );
    expect(v.verdict).toBe("PROGRESSING");
  });

  test("evidence grounding: every passing rule cites its evidence", () => {
    touch("a.txt", 5);
    touch("b.txt", 4);
    const v = judge(claimAt(30, { claim: "done" }));
    expect(v.verdict).toBe("DONE_VERIFIED");
    const r4 = v.rules.find((r) => r.rule === "done-requires-artifacts")!;
    expect(r4.evidence_refs.length).toBeGreaterThan(0);
    const cited = new Set(v.rules.flatMap((r) => r.evidence_refs));
    for (const ref of cited) {
      expect(v.evidence.some((e) => e.ref === ref)).toBe(true);
    }
  });

  test("evidence items carry sha256 for files", () => {
    touch("hashme.txt", 5);
    const v = judge(claimAt(30));
    const files = v.evidence.filter((e) => e.kind === "file");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("claim validation", () => {
  test("rejects bad claim kind", () => {
    expect(() =>
      parseClaim({ lane: "x", claim: "finished", claimed_at: new Date().toISOString(), watch_dirs: [] }),
    ).toThrow();
  });

  test("rejects future claimed_at at verdict time", () => {
    const c = parseClaim({
      lane: "x",
      claim: "running",
      claimed_at: new Date(Date.now() + 3600_000).toISOString(),
      watch_dirs: [dir],
    });
    const v = judge(c);
    expect(v.rules.find((r) => r.rule === "claim-wellformed")!.passed).toBe(false);
  });
});

describe("checkpoint", () => {
  test("appendCheckpointEvent writes the wave4 checkpoint schema", () => {
    const cp = join(dir, "checkpoint.json");
    const ev = appendCheckpointEvent(cp, {
      lane: "test-lane",
      kind: "lane-verify.verdict",
      step: "claim-vs-evidence verification",
      observation: "verdict=STALLED",
      result: "STALLED",
    });
    expect(ev.at).toBeString();
    expect(ev.lane).toBe("test-lane");
    const doc = JSON.parse(readFileSync(cp, "utf8"));
    expect(Array.isArray(doc.events)).toBe(true);
    expect(doc.events).toHaveLength(1);
    expect(doc.events[0].kind).toBe("lane-verify.verdict");
    // append again -> 2 events, schema preserved
    appendCheckpointEvent(cp, { lane: "test-lane", kind: "note", observation: "second" });
    expect(JSON.parse(readFileSync(cp, "utf8")).events).toHaveLength(2);
  });
});
