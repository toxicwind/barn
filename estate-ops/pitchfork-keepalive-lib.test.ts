/**
 * pitchfork-keepalive-lib.test.ts — unit tests for the supervisor keepalive's
 * pure core. Run: `bun test`.
 */
import { expect, test, describe } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backoffDelayMs,
  buildSupervisorArgv,
  resolvePitchforkBin,
  lockPath,
  MAX_BACKOFF_MS,
  BASE_BACKOFF_MS,
} from "./pitchfork-keepalive-lib.ts";

describe("backoffDelayMs", () => {
  test("grows exponentially from the base", () => {
    expect(backoffDelayMs(1)).toBe(BASE_BACKOFF_MS); // 10s
    expect(backoffDelayMs(2)).toBe(20_000);
    expect(backoffDelayMs(3)).toBe(40_000);
  });
  test("caps at MAX_BACKOFF_MS", () => {
    expect(backoffDelayMs(10)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelayMs(99)).toBe(MAX_BACKOFF_MS);
  });
  test("clamps non-positive / fractional attempts", () => {
    expect(backoffDelayMs(0)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(-5)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(1.9)).toBe(BASE_BACKOFF_MS); // floor(1.9)=1
  });
});

describe("buildSupervisorArgv", () => {
  test("runs supervisor with --boot on the resolved binary", () => {
    expect(buildSupervisorArgv("/x/pitchfork")).toEqual([
      "/x/pitchfork",
      "supervisor",
      "run",
      "--boot",
    ]);
  });
});

describe("resolvePitchforkBin", () => {
  test("honors an explicit PITCHFORK_BIN override", () => {
    expect(
      resolvePitchforkBin({ PITCHFORK_BIN: "/opt/custom/pitchfork" }),
    ).toBe("/opt/custom/pitchfork");
  });
  test("returns null when nothing exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-keepalive-"));
    expect(resolvePitchforkBin({}, tmp)).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
  test("resolves a real candidate file in the probe dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-keepalive-"));
    const binDir = join(tmp, ".local/share/mise/installs/pitchfork/2.25.0");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "pitchfork"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    chmodSync(join(binDir, "pitchfork"), 0o755);
    expect(resolvePitchforkBin({}, tmp)).toBe(join(binDir, "pitchfork"));
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("lockPath", () => {
  test("points under the state dir", () => {
    expect(lockPath("/home/toxic")).toBe(
      "/home/toxic/.local/state/pitchfork/keepalive.lock",
    );
  });
});
