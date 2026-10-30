import { test, expect } from "bun:test";
import { Readable } from "stream";
import { createNormalizer } from "../src/transform.mjs";

async function pipeThrough(norm, chunks) {
  const out = [];
  for await (const c of Readable.from(chunks).pipe(norm)) out.push(c.toString());
  return out.join("");
}

test("whole line passes through and is rewritten", async () => {
  const n = createNormalizer();
  const frame = JSON.stringify({ method: "session/new", params: { mcpServers: { a: { command: "/a" } } } }) + "\n";
  const out = await pipeThrough(n, [frame]);
  expect(out.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(out.trim());
  expect(Array.isArray(parsed.params.mcpServers)).toBe(true);
});

test("split frame reassembled", async () => {
  const n = createNormalizer();
  const frame = JSON.stringify({ method: "session/new", params: { mcpServers: { a: { command: "/a" } } } }) + "\n";
  const half = Math.floor(frame.length / 2);
  const out = await pipeThrough(n, [frame.slice(0, half), frame.slice(half)]);
  const parsed = JSON.parse(out.trim());
  expect(parsed.method).toBe("session/new");
  expect(Array.isArray(parsed.params.mcpServers)).toBe(true);
});

test("multi-byte split does not corrupt", async () => {
  const n = createNormalizer();
  const frame = JSON.stringify({ x: "héllo 世界 🚀" }) + "\n";
  const bytes = Buffer.from(frame, "utf-8");
  const mid = Math.floor(bytes.length / 2);
  const out = await pipeThrough(n, [bytes.slice(0, mid), bytes.slice(mid)]);
  expect(JSON.parse(out.trim()).x).toBe("héllo 世界 🚀");
});

test("flush emits trailing partial line", async () => {
  const n = createNormalizer();
  const out = await pipeThrough(n, ['{"a":1}']);
  expect(out).toBe('{"a":1}');
});
