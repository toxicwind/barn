#!/usr/bin/env bun
/**
 * reconcile-agents.test.ts — bin TDD scaffold for the AGENTS.md master contract.
 *
 * Endlessly extensible: add a new test per contract (tau-walkup, kappa-prepend,
 * kairos-hook, ...). Each defends a concrete, externally observable contract:
 * the estate resolves a SINGLE authoritative AGENTS.md and the kairos tooling is
 * live. Reconcile-aware: assertions mirror the reconcile-agents.md checks so CI
 * and reconcile stay in lockstep.
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

describe("AGENTS.md master contract", () => {
  test("cwd under /home/toxic walks up to a single authoritative AGENTS.md (tau-style + kappa-style agree)", async () => {
    const rootAgents = "/home/toxic/AGENTS.md";
    expect(existsSync(rootAgents)).toBe(true);
    const kappaCfg = join(
      process.env.KAPPA_CONFIG_DIR?.trim() || join(homedir(), ".config", "kappa"),
      "AGENTS.md",
    );
    if (existsSync(kappaCfg)) {
      const [root, cfg] = await Promise.all([
        Bun.file(rootAgents).text(),
        Bun.file(kappaCfg).text(),
      ]);
      expect(root).toEqual(cfg);
    } else {
      expect(existsSync(rootAgents)).toBe(true);
    }
  });

  test("kairos hook targets live at pens/barn/estate-ops (run-fast + delend-code-race)", () => {
    for (const p of [
      join(homedir(), "pens/barn/estate-ops/run-fast"),
      join(homedir(), "pens/barn/estate-ops/delend-code-race"),
    ]) {
      expect(existsSync(p), `missing kairos target ${p}`).toBe(true);
    }
  });

  test("the reconcile script is present in the bin surface (~/.local/bin or estate-ops source)", () => {
    const link = join(homedir(), ".local", "bin", "reconcile-agents");
    const src = join(homedir(), "pens/barn/estate-ops/reconcile-agents.md.ts");
    expect(existsSync(link) || existsSync(src)).toBe(true);
  });

  test("root AGENTS.md documents kairos 2s-rule + monadic + green-blue + lock-rebuild (master is verbose)", async () => {
    const text = await Bun.file("/home/toxic/AGENTS.md").text();
    expect(text).toContain("kairos");
    expect(text).toContain("monadic");
    expect(text).toContain("GREEN-BLUE");
    expect(text).toContain("lock");
  });
});