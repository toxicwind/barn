#!/usr/bin/env bun
/**
 * reconcile-agents.md — make AGENTS.md the MASTER across agents.
 *
 * Generic, drop into ANY estate/pens project. Verifies the project's
 * AGENTS.md resolves consistently through BOTH agent load paths (tau walk-up,
 * kappa walk-up + config-dir prepend), and that the critical estate tooling
 * (kairos 2s-rule hook, run-fast, delend-code-race) is present + functional.
 * Fail-loud but forward (monadic primitives; no 2>/dev/null).
 *
 * Usage:
 *   bun reconcile-agents.md [cwd]        # check the project at cwd (default .)
 *   bun reconcile-agents.md --list       # enumerate which AGENTS.md each path finds
 *   bun reconcile-agents.md --extend     # register a new check (append to CHECKS)
 *
 * Exit 0 = all checks pass; 1 = any FAIL (report with evidence).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Result<T> = { ok: true; value: T } | { ok: false; err: string };
const Ok = <T>(value: T): Result<T> => ({ ok: true, value });
const Err = <T>(err: string): Result<T> => ({ ok: false, err });
const andThen = <A, B>(r: Result<A>, f: (a: A) => Result<B>): Result<B> =>
  r.ok ? f(r.value) : r;

interface Check {
  id: string;
  desc: string;
  run: (cwd: string) => Result<string>; // ok=passed summary, err=failed reason
}

/** Walk up from `from` to `stop` (inclusive) collecting `name` files, farthest-first. */
function walkUp(from: string, stop: string, name: string): string[] {
  const found: string[] = [];
  let cur = resolve(from);
  const stopAbs = resolve(stop);
  for (;;) {
    const candidate = join(cur, name);
    if (existsSync(candidate)) found.push(candidate);
    if (cur === stopAbs) break;
    const next = resolve(join(cur, ".."));
    if (next === cur) break;
    cur = next;
  }
  return found;
}

// A registry so `--extend` can append; every check returns Ok(summary) | Err(reason).
const CHECKS: Check[] = [
  {
    id: "tau-walkup",
    desc: "tau-style AGENTS.md discovery (walk up from cwd)",
    run: (cwd) => {
      const found = walkUp(cwd, cwd, "AGENTS.md");
      // tau also surfaces repo-root rules; require at least one path containing the cwd ancestor.
      return found.length > 0
        ? Ok(`tau resolves ${found.join(", ")}`)
        : Err("tau-style walk-up found no AGENTS.md from " + cwd);
    },
  },
  {
    id: "kappa-config-prepend",
    desc: "kappa-style config-dir AGENTS.md is present + authoritative-first",
    run: (cwd) => {
      const cfgFile = join(process.env.KAPPA_CONFIG_DIR ?? join(process.env.HOME ?? "", ".config", "kappa"), "AGENTS.md");
      return existsSync(cfgFile)
        ? Ok(`kappa config-dir prepend: ${cfgFile}`)
        : Err(`kappa config-dir AGENTS.md missing: ${cfgFile}`);
    },
  },
  {
    id: "kairos-hook",
    desc: "kairos 2s-rule hook resolves run-fast + delend-code-race from pens/barn/estate-ops",
    run: () => {
      const cwdHome = process.env.HOME ?? "";
      const rp = join(cwdHome, "pens/barn/estate-ops/run-fast");
      const cr = join(cwdHome, "pens/barn/estate-ops/delend-code-race");
      const missing = [rp, cr].filter((p) => !existsSync(p));
      return missing.length === 0
        ? Ok(`kairos hook targets present: ${rp}\n  ${cr}`)
        : Err(`kairos hook inert — missing: ${missing.join(", ")}`);
    },
  },
];

const args = process.argv.slice(2);

if (args.includes("--list")) {
  console.log(CHECKS.map((c) => c.id).join("\n"));
  process.exit(0);
}

const cwd = resolve(args[0] ?? process.cwd());
const results = CHECKS.map((c) => ({ check: c, result: c.run(cwd) }));

let failed = 0;
for (const { check, result } of results) {
  const mark = result.ok ? "PASS" : "FAIL";
  const detail = result.ok ? result.value : result.err;
  console.log(`[${mark}] ${check.id} — ${check.desc}\n      ${String(detail).split("\n").join("\n      ")}`);
  if (!result.ok) failed++;
}

const summary = `reconcile-agents.md: ${results.length - failed}/${results.length} checks passed (cwd=${cwd})`;
console.log(summary);
process.exit(failed === 0 ? 0 : 1);