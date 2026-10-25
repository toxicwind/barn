import { describe, expect, test } from "bun:test";

describe("timing and latency", () => {
  test("measures request latency", async () => {
    const start = performance.now();
    await new Promise(r => setTimeout(r, 10));
    const end = performance.now();
    const latency = end - start;
    expect(latency).toBeGreaterThanOrEqual(10);
    expect(latency).toBeLessThan(50);
  });

  test("calculates duration correctly", () => {
    const t0 = Date.now();
    const delay = 50;
    setTimeout(() => {}, delay);
    // Duration tracking
    const duration = Date.now() - t0;
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  test("throughput calculation", () => {
    const records = 100;
    const elapsedMs = 2000;
    const throughput = (records / elapsedMs) * 1000;
    expect(throughput).toBe(50);
  });

  test("latency percentiles", () => {
    const latencies = [10, 20, 30, 40, 50];
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    expect(p50).toBe(30);
    expect(p95).toBe(50);
  });
});
