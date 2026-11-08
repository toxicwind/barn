import { describe, expect, test } from "bun:test";
import { localAudit, toDataFrame, exportParquet } from "../src/local-audit";
import { join } from "path";
import { rm } from "fs/promises";

describe("local-audit", () => {
  test("localAudit returns repos from local directories", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.repos.length).toBe(result.total);
  });

  test("localAudit returns repos from estate directory", async () => {
    const result = await localAudit(["/home/toxic/pens/estate"]);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  test("localAudit with --all scans both directories", async () => {
    const result = await localAudit(["/home/toxic/projects", "/home/toxic/pens/estate"]);
    expect(result.total).toBeGreaterThan(0);
    expect(Object.keys(result.byArea).length).toBeGreaterThan(0);
  });

  test("toDataFrame returns correct column structure", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    const df = toDataFrame(result);
    expect(df.name).toBeDefined();
    expect(df.path).toBeDefined();
    expect(df.area).toBeDefined();
    expect(df.lastCommit).toBeDefined();
    expect(df.message).toBeDefined();
    expect(df.commit).toBeDefined();
    expect(df.author).toBeDefined();
    expect(df.name.length).toBe(result.total);
  });

  test("result has correct byArea counts", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    const total = Object.values(result.byArea).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.total);
  });

  test("result has symlinks array", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(Array.isArray(result.symlinks)).toBe(true);
  });

  test("recent count is less than or equal to total", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(result.recent).toBeLessThanOrEqual(result.total);
  });

  test("stale count is less than or equal to total", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(result.stale).toBeLessThanOrEqual(result.total);
  });

  test("exportParquet writes valid file", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    const tmpPath = join("/tmp", `local-audit-test-${Date.now()}.parquet`);
    await exportParquet(result, tmpPath);
    const exists = await Bun.file(tmpPath).exists();
    expect(exists).toBe(true);
    await rm(tmpPath);
  });
});
