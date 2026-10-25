import { describe, expect, test } from "bun:test";
import { localAudit, exportParquet } from "../src/local-audit";
import { join } from "path";

describe("parquet", () => {
  test("exportParquet writes valid file", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    const tmpPath = join("/tmp", `local-audit-test-${Date.now()}.parquet`);
    await exportParquet(result, tmpPath);
    const exists = await Bun.file(tmpPath).exists();
    expect(exists).toBe(true);
  });

  test("exportParquet includes .secrets record", async () => {
    const result = await localAudit(["/home/toxic/projects"]);
    expect(result.records.some(r => r.name === ".secrets")).toBe(true);
  });
});
