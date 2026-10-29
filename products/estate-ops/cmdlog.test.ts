import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// Anti-truncation contract: cmdlog must persist the FULL command output to an
// unbounded file even when its stdout PREVIEW is capped (so the agent never
// misses output), and exit with the child's real exit code.
describe("cmdlog anti-truncation", () => {
  const BIN = "/home/toxic/pens/barn/estate-ops/cmdlog.ts";

  test("persists >1000 lines to the file while previewing only a few", () => {
    const lines = 1500;
    const run = execFileSync(
      "/home/toxic/.bun/bin/bun",
      [BIN, "--", "seq", String(lines)],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    // the capture-line marker tells the reader the full file path
    const marker = run.match(/\[cmdlog: (\d+) lines → ([^\]]+)\]/);
    expect(marker).toBeTruthy();
    const gotLines = Number(marker?.[1]);
    const file = marker?.[2] ?? "";
    // full output persisted to the file (not truncated by the preview)
    expect(gotLines).toBeGreaterThanOrEqual(lines);
    expect(existsSync(file)).toBe(true);
    const filelines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l).length;
    expect(filelines).toBeGreaterThanOrEqual(lines);
  });

  test("exit code is the child's real exit code", () => {
    try {
      execFileSync(
        "/home/toxic/.bun/bin/bun",
        [BIN, "--", "sh", "-c", "exit 7"],
        { encoding: "utf8" },
      );
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.status).toBe(7);
    }
  });
});
