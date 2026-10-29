/**
 * cmdStack — `forge stack` : one layered entrypoint for build, deploy, health
 * and go across the Greek targets. A thin CLI adapter over targets/bluegreen/
 * health; it keeps the switch(command)-style parsing from cli.ts (`--flag
 * value` / boolean `--flag`, positionals relative to the subcommand).
 *
 * Subcommands:
 *   forge stack targets                      list known targets
 *   forge stack build    --target kappa|forge|all [--no-cache] [--dry-run]
 *   forge stack deploy   --target kappa|forge|all [--version <main-short-hash>]
 *                        [--dry-run]
 *   forge stack health   [--target t] [--deep] [--dry-run]
 *   forge stack go       --target kappa|forge|all [--version ...] [--no-build]
 *                        [--no-restart] [--dry-run]
 *
 * `go` stages, flips the active slot, restarts the supervised daemon, verifies
 * health and rolls the slot back on a failed check. `--dry-run` prints the
 * plan and touches nothing. `--deep` on health/go asserts the deployed version
 * marker matches the current `main` commit hash.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TARGETS, target, type Target } from "./targets";
import {
  slotState,
  stageBinary,
  flipActive,
  rollbackActive,
  activeSlot,
  clearSlotDir,
  mainShortHash,
  type SlotState,
} from "./bluegreen";
import { checkTarget, renderHealth, type HealthResult } from "./health";

type Args = { _: string[]; flags: Map<string, string | boolean> };

const num = (flags: Args["flags"], key: string, fallback: number): number => {
  const raw = flags.get(key);
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const str = (flags: Args["flags"], key: string, fallback: string): string => {
  const raw = flags.get(key);
  return typeof raw === "string" ? raw : fallback;
};

function expandTargets(want: string): Target[] {
  if (want === "all") return TARGETS;
  const t = target(want);
  if (t) return [t];
  return [];
}

function gitRootFor(t: Target): string {
  return t.build?.cwd ?? t.artifact.from;
}

async function runBuild(t: Target, dryRun: boolean): Promise<boolean> {
  if (!t.build) throw new Error(`target "${t.name}" has no build task`);
  const cwd = t.build.cwd;
  if (dryRun) {
    process.stdout.write(`  [dry-run] mise run ${t.build.task} (cwd=${cwd})\n`);
    return true;
  }
  const res = Bun.spawnSync(["mise", "run", t.build.task], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  return res.exitCode === 0;
}

function findArtifact(t: Target): string | null {
  const from = t.artifact.from;
  const glob = t.artifact.glob;
  if (glob.includes("*")) {
    // Resolve a `**/…/name` glob to the concrete file under `from`. We walk
    // from the base dir (everything before the first `*`) and return the
    // first existing FILE matching the glob's literal tail. This is what
    // turns kappa's `packages/cli/dist/**/bin/kappa` into the real binary
    // instead of the `dist/` directory.
    const base = glob.split("*")[0]!;
    const tail = glob.split("**/").pop() ?? "";
    const root = join(from, base);
    if (!existsSync(root)) return null;
    return findByTail(root, tail);
  }
  const p = t.resolved(from);
  return existsSync(p) ? p : null;
}

/** Depth-first file search for `leaf` (a relative path tail) under `dir`. */
function findByTail(dir: string, leaf: string): string | null {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (ent.startsWith(".")) continue; // skip .ffs, .git, node_modules hygiene
    const full = join(dir, ent);
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const hit = findByTail(full, leaf);
      if (hit) return hit;
    } else if (full.endsWith(leaf) && leaf) {
      return full;
    }
  }
  return null;
}

async function deployTarget(
  t: Target,
  opts: { version?: string; dryRun: boolean; gitRoot: string },
): Promise<boolean> {
  const s: SlotState = slotState(
    t.deploy.slotDir,
    join(t.deploy.slotDir, t.deploy.ln),
  );
  const version = opts.version ?? mainShortHash(opts.gitRoot);
  if (opts.dryRun) {
    process.stdout.write(
      `  [dry-run] stage ${t.name}@${version} into ${s.slotDir} then flip active\n`,
    );
    return true;
  }
  const artifact = findArtifact(t);
  if (!artifact) {
    process.stderr.write(
      `deploy ${t.name}: no artifact at ${t.artifact.from}/${t.artifact.glob} (build first?)\n`,
    );
    return false;
  }
  stageBinary(s, artifact, version);
  const staged = activeSlot(s) === "green" ? "blue" : "green";
  flipActive(s, staged);
  process.stdout.write(
    `  deployed ${t.name} -> active=${staged} version=${version}\n`,
  );
  return true;
}

async function healthTarget(
  t: Target,
  opts: { deep: boolean; dryRun: boolean; gitRoot: string },
): Promise<HealthResult> {
  if (opts.dryRun) {
    return {
      target: t.name,
      ok: true,
      detail:
        "[dry-run] would probe " +
        (t.health.kind === "http" ? t.health.url : t.health.argv.join(" ")),
      deep: opts.deep,
    } as HealthResult;
  }
  return checkTarget(t, { deep: opts.deep, gitRoot: opts.gitRoot });
}

const STACK_HELP = `forge stack — layered build/deploy/health/go across Greek targets.

usage:
  forge stack targets
  forge stack build   --target <name>|all [--no-cache] [--dry-run]
  forge stack deploy  --target <name>|all [--version <hash>] [--dry-run]
  forge stack health  [--target <name>|all] [--deep] [--dry-run]
  forge stack go      --target <name>|all [--version <hash>] [--no-build]
                      [--no-restart] [--dry-run]

targets: ${TARGETS.map((t) => t.name).join(", ")} (or "all")
`;

export async function cmdStack(args: Args): Promise<number> {
  const sub = args._[0];
  const targetName = str(args.flags, "target", "all");
  const dryRun = args.flags.get("dry-run") === true;
  const deep = args.flags.get("deep") === true;
  const noBuild = args.flags.get("no-build") === true;
  const noRestart = args.flags.get("no-restart") === true;
  const targets = expandTargets(targetName);

  if (targets.length === 0 && sub !== "targets") {
    process.stderr.write(
      `stack: unknown target "${targetName}" (known: ${TARGETS.map((t) => t.name).join(", ")})\n`,
    );
    return 2;
  }

  switch (sub) {
    case "targets": {
      for (const t of TARGETS) {
        process.stdout.write(
          `  ${t.name.padEnd(8)} build=${t.build?.task ?? "-"}  probe=${t.health.kind}:${t.health.kind === "http" ? t.health.url : t.health.argv.join(" ")}\n`,
        );
      }
      return 0;
    }

    case "build": {
      let ok = true;
      for (const t of targets) {
        process.stdout.write(`forge stack build: ${t.name}\n`);
        if (!(await runBuild(t, dryRun))) ok = false;
      }
      return ok ? 0 : 1;
    }

    case "deploy": {
      const version = str(args.flags, "version", "");
      let ok = true;
      for (const t of targets) {
        process.stdout.write(`forge stack deploy: ${t.name}\n`);
        if (
          !(await deployTarget(t, {
            version: version || undefined,
            dryRun,
            gitRoot: gitRootFor(t),
          }))
        )
          ok = false;
      }
      return ok ? 0 : 1;
    }

    case "health": {
      const results: HealthResult[] = [];
      for (const t of targets)
        results.push(
          await healthTarget(t, { deep, dryRun, gitRoot: gitRootFor(t) }),
        );
      for (const line of renderHealth(results))
        process.stdout.write(`${line}\n`);
      return results.every((r) => r.ok) ? 0 : 1;
    }

    case "go": {
      // Phase 1: build (skip with --no-build)
      if (!noBuild) {
        for (const t of targets) {
          process.stdout.write(`forge stack go: building ${t.name}\n`);
          if (!(await runBuild(t, dryRun))) {
            process.stderr.write(
              `forge stack go: build failed for ${t.name}\n`,
            );
            return 1;
          }
        }
      } else if (dryRun) {
        process.stdout.write("  [dry-run] skipping build (--no-build)\n");
      }

      // Phase 2: deploy (stage + flip), capture prior slot for rollback
      const prior: Record<string, "blue" | "green" | "none"> = {};
      for (const t of targets) {
        process.stdout.write(`forge stack go: deploying ${t.name}\n`);
        if (dryRun) {
          const s = slotState(
            t.deploy.slotDir,
            join(t.deploy.slotDir, t.deploy.ln),
          );
          process.stdout.write(
            `  [dry-run] stage+flip ${t.name} (prior=${activeSlot(s)})\n`,
          );
          continue;
        }
        const version =
          str(args.flags, "version", "").trim() || mainShortHash(gitRootFor(t));
        const ok = await deployTarget(t, {
          version,
          dryRun: false,
          gitRoot: gitRootFor(t),
        });
        if (!ok) return 1;
        prior[t.name] = activeSlot(
          slotState(t.deploy.slotDir, join(t.deploy.slotDir, t.deploy.ln)),
        );
      }

      // Phase 3: restart supervised daemon(s)
      if (!dryRun && !noRestart) {
        for (const t of targets) {
          if (!t.supervisor) {
            process.stdout.write(
              `forge stack go: no supervisor for ${t.name}; skipping restart\n`,
            );
            continue;
          }
          process.stdout.write(`forge stack go: restarting ${t.supervisor}\n`);
          const r = Bun.spawnSync(["pitchfork", "restart", t.supervisor], {
            stdout: "inherit",
            stderr: "inherit",
          });
          if (r.exitCode !== 0) {
            process.stderr.write(
              `forge stack go: restart ${t.supervisor} failed (exit ${r.exitCode})\n`,
            );
            process.stderr.write(
              `forge stack go: NOT rolling back automatically on restart failure — health gate follows\n`,
            );
          }
        }
      }

      // Phase 4: health gate + rollback
      let allOk = true;
      for (const t of targets) {
        const h = await healthTarget(t, {
          deep,
          dryRun,
          gitRoot: gitRootFor(t),
        });
        process.stdout.write(
          `${deep ? (h.ok ? "  GREEN " : "  STALE ") : h.ok ? "  PASS  " : "  FAIL  "}${t.name}: ${h.detail}\n`,
        );
        if (!h.ok) allOk = false;
      }
      if (dryRun) {
        process.stdout.write("forge stack go: [dry-run] complete\n");
        return 0;
      }
      if (allOk) {
        process.stdout.write("forge stack go: all targets healthy\n");
        return 0;
      }
      // Rollback
      process.stderr.write(
        "forge stack go: health gate failed — rolling back active slot(s)\n",
      );
      for (const t of targets) {
        const p = prior[t.name];
        if (!p || p === "none") continue;
        const s = slotState(
          t.deploy.slotDir,
          join(t.deploy.slotDir, t.deploy.ln),
        );
        rollbackActive(s, p);
        process.stdout.write(`forge stack go: rolled back ${t.name} to ${p}\n`);
      }
      return 1;
    }

    case "--help":
    case "help":
    default:
      process.stdout.write(`${STACK_HELP}\n`);
      return sub === "help" ? 0 : 2;
  }
}
