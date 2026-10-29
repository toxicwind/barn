/**
 * stack targets — the data-driven Greek-product map.
 *
 * Forge is a layered deployment CL: build -> deploy -> health -> go. Every
 * Greek product that can be built, deployed and health-checked participates
 * through one entry here. Adding a target is DATA, not new code: fill in a
 * row and the `stack` subcommand handles it.
 *
 * `supervisor` is the pitchfork daemon name used by `go` to restart after
 * the active-slot flip. `probe` is the health check: "http" hits the ready
 * URL the supervisor itself uses; "cli" runs the binary's own doctor-style
 * command. `--deep` additionally asserts the deployed version marker matches
 * the current `main` commit hash, catching a stale blue/green restore.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

/** Where the stack stages blue/green slots and the active symlink. */
export const RUNTIME_ROOT =
  process.env.FORGE_STACK_RUNTIME ?? "/home/toxic/var/runtime/forge/deploy";

export type Probe =
  { kind: "http"; url: string } | { kind: "cli"; argv: string[] };

export type Target = {
  /** canonical name, e.g. "kappa" | "forge" */
  name: string;
  /** mise build task + the repo dir it runs in; cache opts into mbx-cache. */
  build?: { task: string; cwd: string; cache?: boolean };
  /** relative artifact glob (from cwd) that becomes the deployable binary. */
  artifact: { from: string; glob: string };
  /** active-slots live at <slotDir>/<main-short-hash>; ln is the live symlink. */
  deploy: { slotDir: string; ln: string };
  /** health probe for `stack health` and post-`go` verification. */
  health: Probe & { timeoutMs?: number };
  /** pitchfork daemon name for `go` restart; omit => restart skipped. */
  supervisor?: string;
  /** resolved absolute path to the packed binary. */
  resolved(srcRoot: string): string;
};

function globPath(from: string, glob: string): string {
  const p = join(from, glob);
  return p;
}

/**
 * v1 targets. `forge` builds THIS CLI (mise task `forge-build`); `kappa`
 * builds the @kappacode CLI. Extra Greek names (tau, kite, kilo, ...) are
 * appended as pure data.
 */
export const TARGETS: Target[] = [
  {
    name: "kappa",
    build: {
      task: "kappa-build",
      cwd: "/home/toxic/pens/olympus/products/kappa/kappa-code",
      cache: true,
    },
    artifact: {
      from: "/home/toxic/pens/olympus/products/kappa/kappa-code",
      glob: "packages/cli/dist/**/bin/kappa",
    },
    deploy: { slotDir: join(RUNTIME_ROOT, "kappa"), ln: "active" },
    health: { kind: "http", url: "http://127.0.0.1:25159/", timeoutMs: 3000 },
    supervisor: "estate/kappa-acp",
    resolved(srcRoot: string): string {
      const p = globPath(srcRoot, this.artifact.glob);
      return p;
    },
  },
  {
    name: "forge",
    build: {
      task: "forge-build",
      cwd: "/home/toxic/pens/barn/forge",
      cache: true,
    },
    artifact: { from: "/home/toxic/pens/barn/forge", glob: "bin/forge.ts" },
    deploy: { slotDir: join(RUNTIME_ROOT, "forge"), ln: "active" },
    health: {
      kind: "cli",
      argv: ["bun", "/home/toxic/pens/barn/forge/bin/forge.ts", "doctor"],
      timeoutMs: 30000,
    },
    resolved(srcRoot: string): string {
      const p = globPath(srcRoot, this.artifact.glob);
      return existsSync(p) ? p : p;
    },
  },
];

export function target(name: string): Target | undefined {
  if (name === "all") return undefined;
  return TARGETS.find((t) => t.name === name);
}
