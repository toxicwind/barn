/**
 * pitchfork-restart-lib.test.ts — unit tests for the pure restart core.
 * Run: `bun test bin/pitchfork-restart-lib.test.ts`.
 */
import { expect, test, describe } from "bun:test";

import {
  STOP_TIMEOUT,
  KILL_TIMEOUT,
  START_SETTLE_SECONDS,
  parseStatusPid,
  hasRunningStatus,
  isLockTarget,
  daemonLockFiles,
  initialSweepLabel,
  sweepRoundLabel,
  planReap,
  SWEEP_ABSENT_PREFIX,
  SWEEP_DELETED_AFTER_REAP_PREFIX,
  SWEEP_HOLDER_SURVIVED_PREFIX,
} from "./pitchfork-restart-lib.ts";

describe("constants", () => {
  test("match the bash restart semantics", () => {
    expect(STOP_TIMEOUT).toBe(30);
    expect(KILL_TIMEOUT).toBe(10);
    expect(START_SETTLE_SECONDS).toBe(2);
  });
});

describe("parseStatusPid", () => {
  test("extracts the pid from the real status format", () => {
    const out = `Name: estate/herd
PID: 519143
Status: running
Port: 25100 (active)
`;
    expect(parseStatusPid(out)).toBe("519143");
  });
  test("returns null when no PID: line or pid is empty", () => {
    expect(parseStatusPid("Name: x\nStatus: stopped\n")).toBeNull();
    expect(parseStatusPid("PID:\nName: x\n")).toBeNull();
    expect(parseStatusPid("")).toBeNull();
  });
});

describe("hasRunningStatus", () => {
  test("detects a running daemon", () => {
    expect(hasRunningStatus("PID: 5\nStatus: running\n")).toBe(true);
  });
  test("rejects stopped/errored/blank output", () => {
    expect(hasRunningStatus("Status: stopped")).toBe(false);
    expect(hasRunningStatus("Status: unknown")).toBe(false);
    expect(hasRunningStatus("")).toBe(false);
  });
});

describe("isLockTarget", () => {
  const exists = (p: string) => p === "/lock/a.lock" || p === "/lock/b.lck";
  test("includes real .lock and .lck files", () => {
    expect(isLockTarget("/lock/a.lock", exists)).toBe(true);
    expect(isLockTarget("/lock/b.lck", exists)).toBe(true);
  });
  test("skips non-lock suffixes", () => {
    expect(isLockTarget("/lock/a.txt", exists)).toBe(false);
    expect(isLockTarget("/lock/a", exists)).toBe(false);
  });
  test("skips deleted (gone) locks", () => {
    expect(isLockTarget("/lock/a.lock (deleted)", exists)).toBe(false);
  });
  test("skips locks whose file no longer exists", () => {
    expect(isLockTarget("/lock/ghost.lock", exists)).toBe(false);
  });
});

describe("daemonLockFiles", () => {
  test("enumerates and dedupes the daemon's real lock files", () => {
    const exists = (p: string) => p.startsWith("/lock/");
    const fds = [
      { fd: "3", target: "/lock/only.lock" },
      { fd: "4", target: "/lock/dup.lock" },
      { fd: "5", target: "/lock/dup.lock" },
      { fd: "6", target: "/run/x.sock" },
      { fd: "7", target: null },
      { fd: "8", target: "/lock/gone.lock (deleted)" },
    ];
    const locks = daemonLockFiles(fds, exists);
    expect(locks.sort()).toEqual(["/lock/dup.lock", "/lock/only.lock"]);
  });
  test("returns empty for a pid with no lock fds", () => {
    const exists = () => false;
    expect(daemonLockFiles([{ fd: "3", target: "/x.lock" }], exists)).toEqual(
      [],
    );
  });
});

describe("initialSweepLabel", () => {
  test("marks an absent lock", () => {
    expect(initialSweepLabel(false)).toBe(SWEEP_ABSENT_PREFIX.trim());
  });
  test("pending when the lock exists", () => {
    expect(initialSweepLabel(true)).toBe("pending");
  });
});

describe("sweepRoundLabel", () => {
  test("labels a clean reap", () => {
    expect(sweepRoundLabel("/lock/x.lock", [])).toBe(
      `${SWEEP_DELETED_AFTER_REAP_PREFIX}/lock/x.lock`,
    );
  });
  test("labels surviving holders", () => {
    expect(sweepRoundLabel("/lock/x.lock", ["10", "11"])).toBe(
      `${SWEEP_HOLDER_SURVIVED_PREFIX}/lock/x.lock holders=10,11`,
    );
  });
});

describe("planReap", () => {
  test("schedules TERM for all then KILL opportunity for the same set", () => {
    const p = planReap(["10", "20"]);
    expect(p.term).toEqual(["10", "20"]);
    expect(p.killAfter2s).toEqual(["10", "20"]);
  });
});
