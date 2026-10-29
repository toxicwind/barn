// worker-queue-watch.test.ts — tests for the event-driven admission logic.
// Run: bun test worker-queue-watch.test.ts
import { describe, test, expect } from "bun:test";
import { dispatchReady, shouldSignal, staleIds } from "./worker-queue-watch";

describe("dispatchReady", () => {
  test("pending + free slot => ready", () => {
    expect(dispatchReady(3, 2, 8)).toBe(true);
  });
  test("no pending => not ready", () => {
    expect(dispatchReady(0, 2, 8)).toBe(false);
  });
  test("at capacity => not ready", () => {
    expect(dispatchReady(3, 8, 8)).toBe(false);
  });
  test("over capacity clamps, not ready", () => {
    expect(dispatchReady(3, 10, 8)).toBe(false);
  });
  test("zero max workers never ready", () => {
    expect(dispatchReady(3, 0, 0)).toBe(false);
  });
});

describe("shouldSignal", () => {
  const R = 900;
  test("false -> true edge fires", () => {
    const r = shouldSignal(1000, 0, false, true, R);
    expect(r.fire).toBe(true);
    expect(r.newLastSignal).toBe(1000);
  });
  test("stays true, within re-alert window => silent", () => {
    const r = shouldSignal(1500, 1000, true, true, R);
    expect(r.fire).toBe(false);
    expect(r.newLastSignal).toBe(1000);
  });
  test("stays true past re-alert window => fires", () => {
    const r = shouldSignal(1900, 1000, true, true, R);
    expect(r.fire).toBe(true);
    expect(r.newLastSignal).toBe(1900);
  });
  test("true -> false edge => silent, keeps old timestamp", () => {
    const r = shouldSignal(2000, 1000, true, false, R);
    expect(r.fire).toBe(false);
    expect(r.newLastSignal).toBe(1000);
  });
  test("stays false => silent", () => {
    const r = shouldSignal(2000, 1000, false, false, R);
    expect(r.fire).toBe(false);
  });
  test("no prior signal on record => fires (first ever)", () => {
    const r = shouldSignal(1000, 0, true, true, R);
    expect(r.fire).toBe(true);
  });
  test("exactly at re-alert boundary fires", () => {
    const r = shouldSignal(1900, 1000, true, true, R);
    expect(r.fire).toBe(true);
  });
});

describe("staleIds", () => {
  const NOW = 1_790_735_000;
  test("heartbeat older than threshold => stale", () => {
    const items = [{ id: "a", heartbeat: new Date((NOW - 2000) * 1000).toISOString() }];
    expect(staleIds(items, NOW, 1800)).toEqual(["a"]);
  });
  test("fresh heartbeat => not stale", () => {
    const items = [{ id: "a", heartbeat: new Date((NOW - 100) * 1000).toISOString() }];
    expect(staleIds(items, NOW, 1800)).toEqual([]);
  });
  test("falls back to started when no heartbeat", () => {
    const items = [{ id: "a", started: new Date((NOW - 2000) * 1000).toISOString() }];
    expect(staleIds(items, NOW, 1800)).toEqual(["a"]);
  });
  test("heartbeat wins over older started", () => {
    const items = [{
      id: "a",
      started: new Date((NOW - 5000) * 1000).toISOString(),
      heartbeat: new Date((NOW - 100) * 1000).toISOString(),
    }];
    expect(staleIds(items, NOW, 1800)).toEqual([]);
  });
  test("item with no timestamps skipped", () => {
    expect(staleIds([{ id: "a" }], NOW, 1800)).toEqual([]);
  });
  test("mixed batch returns only stale", () => {
    const items = [
      { id: "a", heartbeat: new Date((NOW - 2000) * 1000).toISOString() },
      { id: "b", heartbeat: new Date((NOW - 100) * 1000).toISOString() },
      { id: "c", started: new Date((NOW - 9000) * 1000).toISOString() },
    ];
    expect(staleIds(items, NOW, 1800).sort()).toEqual(["a", "c"]);
  });
  test("exactly at threshold is not stale (strict >)", () => {
    const items = [{ id: "a", heartbeat: new Date((NOW - 1800) * 1000).toISOString() }];
    expect(staleIds(items, NOW, 1800)).toEqual([]);
  });
});
