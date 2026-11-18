import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CHECKER = join(import.meta.dir, "../scripts/check-mcp-config-ssot.ts");
const THRESHER_SCHEMA = JSON.stringify({ mcpServers: { gateway: { url: "http://127.0.0.1:25127/mcp" } } });
const BORNITE_SCHEMA = JSON.stringify({ mcpServers: [{ name: "x", command: "uvx" }] });

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-ssot-"));
  mkdirSync(join(root, "barn/products/thresher"), { recursive: true });
  writeFileSync(join(root, "barn/products/thresher/mcp_config.json"), THRESHER_SCHEMA);
  return root;
}

function run(root: string) {
  return spawnSync("bun", [CHECKER], {
    env: { ...process.env, PENS_ROOT: root, SSOT_PATH: join(root, "barn/products/thresher/mcp_config.json") },
    encoding: "utf-8",
  });
}

describe("check-mcp-config-ssot", () => {
  test("clean tree: only SSOT, exits 0", () => {
    const root = makeTree();
    try {
      const r = run(root);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("thresher-schema copy elsewhere FAILS (exit 1)", () => {
    const root = makeTree();
    try {
      mkdirSync(join(root, "ranch/products/foo"), { recursive: true });
      writeFileSync(join(root, "ranch/products/foo/mcp_config.json"), THRESHER_SCHEMA);
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("ranch/products/foo/mcp_config.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bornite-schema (list) and vendored .codeium copies are EXCLUDED (exit 0)", () => {
    const root = makeTree();
    try {
      mkdirSync(join(root, "geode/products/bornite/mesh/gateway"), { recursive: true });
      writeFileSync(join(root, "geode/products/bornite/mesh/gateway/mcp_config.json"), BORNITE_SCHEMA);
      mkdirSync(join(root, "ranch/products/github-search/.codeium/windsurf"), { recursive: true });
      writeFileSync(join(root, "ranch/products/github-search/.codeium/windsurf/mcp_config.json"), THRESHER_SCHEMA);
      const r = run(root);
      expect(r.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing SSOT FAILS (exit 2)", () => {
    const root = makeTree();
    try {
      rmSync(join(root, "barn/products/thresher/mcp_config.json"));
      const r = run(root);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("SSOT missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});