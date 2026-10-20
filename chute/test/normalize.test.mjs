import { test, expect } from "bun:test";
import { normalizeServer, normalizeMcpServers, rewriteFrame, rewriteLine } from "../src/normalize.mjs";

test("stdio entry gets full shape", () => {
  expect(normalizeServer({ command: "/bin/x", args: ["-a"] })).toEqual({
    type: "stdio", name: "", command: "/bin/x", args: ["-a"], env: [],
  });
});

test("url entry preserved with type=http", () => {
  expect(normalizeServer({ name: "s", url: "http://x:1/mcp" })).toEqual({
    type: "http", name: "s", url: "http://x:1/mcp",
  });
});

test("url entry with headers preserved", () => {
  expect(normalizeServer({ url: "http://x", headers: { A: "1" } })).toEqual({
    type: "http", name: "", url: "http://x", headers: { A: "1" },
  });
});

test("explicit type overrides default", () => {
  expect(normalizeServer({ url: "http://x", type: "sse" }).type).toBe("sse");
});

test("non-object becomes empty stdio", () => {
  expect(normalizeServer(null)).toEqual({ type: "stdio", name: "", command: "", args: [], env: [] });
  expect(normalizeServer("nope")).toEqual({ type: "stdio", name: "", command: "", args: [], env: [] });
});

test("object form converts to array with key as name", () => {
  const r = normalizeMcpServers({ s1: { command: "/x" }, s2: { url: "http://y" } });
  expect(r).toHaveLength(2);
  expect(r[0].name).toBe("s1");
  expect(r[1].name).toBe("s2");
  expect(r[1].url).toBe("http://y");
});

test("undefined becomes empty array", () => {
  expect(normalizeMcpServers(undefined)).toEqual([]);
});

test("rewriteFrame touches only session/new and session/load", () => {
  const m1 = { method: "session/new", params: { mcpServers: { a: { command: "/a" } } } };
  rewriteFrame(m1);
  expect(Array.isArray(m1.params.mcpServers)).toBe(true);

  const m2 = { method: "session/cancel", params: { mcpServers: "untouched" } };
  rewriteFrame(m2);
  expect(m2.params.mcpServers).toBe("untouched");
});

test("rewriteLine is idempotent for non-JSON", () => {
  expect(rewriteLine("not json")).toBe("not json");
  expect(rewriteLine("")).toBe("");
});

test("rewriteLine preserves non-target frames", () => {
  const line = JSON.stringify({ method: "other", params: { x: 1 } });
  expect(rewriteLine(line)).toBe(line);
});
