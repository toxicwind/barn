import { describe, expect, test } from "bun:test";
import { localAudit, toDataFrame } from "../src/local-audit";

describe("dataframe", () => {
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
});
