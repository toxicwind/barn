import { describe, expect, test } from "bun:test";
import { localAudit } from "../src/local-audit";

describe("local-audit", () => {
  test("localAudit returns repos from local directories", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.repos.length).toBe(result.total);
  });

  test("localAudit returns repos from estate directory", async () => {
    const result = await localAudit(["/home/toxic/estate"]);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  test("localAudit with --all scans both directories", async () => {
    const result = await localAudit(["/home/toxic/projects", "/home/toxic/estate"]);
    expect(result.total).toBeGreaterThan(0);
    expect(Object.keys(result.byArea).length).toBeGreaterThan(0);
  });

  test("recent count is less than or equal to total", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(result.recent).toBeLessThanOrEqual(result.total);
  });

  test("stale count is less than or equal to total", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(result.stale).toBeLessThanOrEqual(result.total);
  });
});
