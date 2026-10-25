import { test, describe, expect } from "bun:test";
import { localZeroShot, rankModel, sortByRank, pickLabel, completionsClassify, cosine } from "../src/hf";

describe("hf module — pure-Bun, no network", () => {
  test("localZeroShot ranks relevant label first", () => {
    const res = localZeroShot("a repository for self-hosted agent tooling", ["tool", "infra", "vendor"]);
    expect(res.winner).toBe("tool");
    expect(res.score).toBeGreaterThan(0);
    expect(res.confident).toBe(true);
  });

  test("localZeroShot classifies against rich label descriptions (borrowed lodestone pattern)", () => {
    const res = localZeroShot("docker compose nginx serving a website", [
      { id: "website", desc: "a public website or static site served over the web" },
      { id: "mcp", desc: "an MCP server exposing agent tools over a protocol" },
      { id: "database", desc: "a database engine or storage backend" },
    ]);
    expect(res.winner).toBe("website");
  });

  test("localZeroShot abstains below confidence threshold instead of false-best (borrowed freenary ACCEPT gate)", () => {
    // genuinely disjoint labels — no shared words/trigrams with the probe
    const res = localZeroShot("quantum flux reverb", ["zzqkft", "xyzzy"]);
    expect(res.confident).toBe(false);
    expect(res.winner).toBe("");
  });

  test("rankModel combines downloads+likes and is monotone in log-likes", () => {
    const low = rankModel({ id: "a", downloads: 100, likes: 1, trending: 0 });
    const high = rankModel({ id: "b", downloads: 100, likes: 1_000_000, trending: 0 });
    expect(high).toBeGreaterThan(low);
  });

  test("sortByRank returns descending", () => {
    const arr = sortByRank([
      { id: "z", downloads: 1, likes: 1, trending: 1, modifiedAt: new Date().toISOString() },
      { id: "a", downloads: 1_000_000, likes: 100, trending: 50, modifiedAt: new Date().toISOString() },
    ]);
    expect(arr[0].id).toBe("a");
  });

  test("pickLabel parses LLM completions output to a label (punct/case/prefix tolerant)", () => {
    const labels = ["website", "mcp", "database"];
    expect(pickLabel("website", labels)).toBe("website");
    expect(pickLabel("  Database.  ", labels)).toBe("database");
    expect(pickLabel("website neither...", labels)).toBe("website");
    expect(pickLabel("weird output", labels)).toBe("");
    expect(pickLabel("", ["a", "b"])).toBe("");
  });

  test("cosine similarity (bge-m3 embed classifier math)", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(1, 6);
    expect(cosine([2, 0], [0, 2])).toBeCloseTo(0, 6);
    expect(cosine([1, 0], [3, 0])).toBeCloseTo(1, 6); // collinear
  });
});