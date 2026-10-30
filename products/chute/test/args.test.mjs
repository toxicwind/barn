import { test, expect } from "bun:test";
import { parseArgs } from "../src/args.mjs";

test("empty argv is invalid", () => {
  expect(parseArgs([], {}).valid).toBe(false);
});

test("--check alone is valid", () => {
  const a = parseArgs(["--check"], {});
  expect(a.check).toBe(true);
  expect(a.valid).toBe(true);
});

test("--port then -- then cmd", () => {
  const a = parseArgs(["--port", "5000", "--", "echo", "hi"], {});
  expect(a.port).toBe(5000);
  expect(a.cmd).toEqual(["echo", "hi"]);
  expect(a.valid).toBe(true);
});

test("env fallback when no --port", () => {
  const a = parseArgs(["--", "x"], { CHUTE_PORT: "7777" });
  expect(a.port).toBe(7777);
});

test("invalid port rejected", () => {
  const a = parseArgs(["--port", "notanumber", "--", "x"], {});
  expect(a.valid).toBe(false);
  expect(a.error).toBeDefined();
});

test("bare cmd without -- is invalid", () => {
  expect(parseArgs(["echo", "hi"], {}).valid).toBe(false);
});
