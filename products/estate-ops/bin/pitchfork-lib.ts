/**
 * pitchfork-lib.ts — pure, typed core of the estate pitchfork dispatch shim
 * (bin/pitchfork.ts). No side effects at import time; all decision logic is
 * unit-tested in pitchfork-lib.test.ts.
 *
 * It reproduces the behavior of the legacy bash wrapper bin/pitchfork so the
 * Bun/TS shim is a provable drop-in. The bash wrapper's two jobs are:
 *   1. resolve the real pitchfork binary (priority-ordered candidates);
 *   2. pre-process argv: collapse `status` -> `list`, and guard against the
 *      deprecated `sovereign/` prefix on lifecycle subcommands.
 *
 * The `sovereign/` guard mirrors the bash exactly: when a lifecycle arg is
 * `sovereign/<x>` and the live registry has `estate/<x>` but NOT
 * `sovereign/<x>`, the shim REFUSES on stderr with exit 1 (guiding the
 * operator to the estate/ name). It does NOT silently rewrite argv, so callers
 * that depend on the refusal keep their behavior. The estate/<x> form is
 * the sole registered namespace today (see state.toml + the runbook), hence
 * the deprecation.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Candidate pitchfork binary paths, in priority order.
 *
 * pitchfork is a mise-managed tool in this estate (declared in
 * ~/.config/mise/conf.d/00-toolchain.toml), so the source of truth is MISE,
 * not a hardcoded version. The first candidate is mise's maintained "global"
 * marshaller (a symlink mise keeps pointing at the active version) and then a
 * version-agnostic scan of every installed column — so this survives pitchfork
 * version bumps instead of pinning a stale 2.25.0. `~/.local/bin/pitchfork-bin`
 * and the 2026-10-08 archive copies remain as last-resort fallbacks.
 */
export function pitchforkFromInstallVersion(home: string): string | null {
  const installDir = join(home, ".local/share/mise/installs/pitchfork");
  const marshaller = join(installDir, "global/pitchfork");
  if (existsSync(marshaller)) return marshaller;
  let versions: string[];
  try {
    versions = readdirSync(installDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^2\./.test(d.name))
      .map((d) => join(installDir, d.name, "pitchfork"))
      .filter((p) => existsSync(p))
      .sort();
  } catch {
    versions = [];
  }
  return versions.length > 0 ? versions[0] : null;
}

/** Archive copies kept after the 2026-10-08 home reorg (same SHA as live). */
export function pitchforkArchiveCandidates(home: string): string[] {
  const base = join(
    home,
    "archive/home-dirs-2026/.local/share/mise/installs/pitchfork",
  );
  let versions: string[];
  try {
    versions = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^2\./.test(d.name))
      .map((d) => join(base, d.name, "pitchfork"))
      .filter((p) => existsSync(p))
      .sort();
  } catch {
    versions = [];
  }
  return versions;
}

export function pitchforkCandidates(home: string): string[] {
  const install = pitchforkFromInstallVersion(home);
  return [
    install,
    join(home, ".local/bin/pitchfork-bin"),
    ...pitchforkArchiveCandidates(home),
    join(home, "archive/home-dirs-2026/.local/bin/pitchfork-bin"),
  ].filter((p): p is string => !!p);
}

/**
 * Resolve the real pitchfork binary. Honors an explicit PITCHFORK_BIN
 * override first, else the first existing candidate. Returns null when
 * nothing usable exists (caller -> exit 127, matching the bash).
 */
export function resolvePitchforkBin(
  env: Record<string, string | undefined>,
  home = process.env.HOME ?? "/home/toxic",
): string | null {
  const override = env.PITCHFORK_BIN;
  if (override && override.trim()) return override;
  for (const candidate of pitchforkCandidates(home)) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Message the bash emits (stderr, exit 127) when no binary is usable. */
export const NO_BINARY_MESSAGE = "pitchfork: no usable pitchfork binary found";

/** Lifecycle subcommands whose `sovereign/` args are guarded (matches $1 switch). */
const FORBIDDEN_SUBCOMMANDS = new Set([
  "stop",
  "restart",
  "kill",
  "clean",
  "c",
  "disable",
  "d",
  "enable",
  "e",
  "start",
  "run",
  "r",
]);

/** True when the first real arg is a guarded lifecycle subcommand. */
export function isLifecycleSubcommand(firstArg: string | undefined): boolean {
  return firstArg !== undefined && FORBIDDEN_SUBCOMMANDS.has(firstArg);
}

/**
 * Collapse the `status` (no name) shortcut to `list`, exactly like the bash:
 * real argv of exactly ["status"] -> ["list"]. Anything else (including a bare
 * `status <name>`) is returned unchanged.
 */
export function normalizeStatusToList(realArgs: string[]): string[] {
  if (realArgs.length === 1 && realArgs[0] === "status") return ["list"];
  return realArgs;
}

/** Strip a leading `sovereign/` prefix; null when the arg is not sovereign/*. */
export function sovereignShort(arg: string): string | null {
  return arg.startsWith("sovereign/") ? arg.slice("sovereign/".length) : null;
}

/** Map a `sovereign/<x>` arg to its modern `estate/<x>` spelling. */
export function sovereignToEstate(arg: string): string {
  const short = sovereignShort(arg);
  return short === null ? arg : `estate/${short}`;
}

/**
 * Extract the set of registered daemon ids from `pitchfork list` output.
 * list lines look like `estate/<name>  <status> ...`; the id is the first
 * whitespace token (mirrors `awk '{print $1}'` in the bash).
 */
export function extractListIds(listOutput: string): Set<string> {
  const ids = new Set<string>();
  for (const line of listOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/)[0];
    if (first) ids.add(first);
  }
  return ids;
}

/** The three stderr lines the bash prints on a sovereign/ refusal. */
export function sovereignRefusalLines(arg: string, short: string): string[] {
  return [
    `pitchfork: REFUSED: "${arg}" is not a registered daemon id.`,
    `pitchfork: the live daemon is "estate/${short}" — sovereign/ is a deprecated prefix.`,
    `pitchfork: re-run with the estate/ name, or "pitchfork list" to see registered ids.`,
  ];
}

/**
 * Outcome of scrutinizing one lifecycle arg set against the registered ids.
 * `pass` means the real argv is forwarded untouched; `refused` means the
 * shim must print the returned stderr lines and exit 1.
 */
export type LifecycleDecision =
  { kind: "pass" } | { kind: "refused"; stderr: string[] };

/**
 * Guard the deprecated `sovereign/` prefix on lifecycle args.
 *
 * Mirrors the bash exactly: for each arg (after the subcommand) that is
 * `sovereign/<x>`, if the registry has `estate/<x>` but NOT `sovereign/<x>`,
 * refuse. If neither string is registered, or `sovereign/<x>` IS registered,
 * pass. Resolution of `ids` is lazy in the bash (only on first sovereign arg);
 * here the caller resolves the list id set once when needed.
 */
export function decideLifecycleArgs(
  realArgs: string[],
  ids: Set<string>,
): LifecycleDecision {
  for (const arg of realArgs.slice(1)) {
    const short = sovereignShort(arg);
    if (short === null) continue;
    if (ids.has(arg)) continue; // sovereign/<x> registered itself -> pass through.
    if (ids.has(`estate/${short}`)) {
      return { kind: "refused", stderr: sovereignRefusalLines(arg, short) };
    }
    // Neither registered -> pass through untouched (bash does not refuse).
  }
  return { kind: "pass" };
}

/**
 * Build the full decision for the shim: resolve binary, apply the status
 * shortcut, then the sovereign/ guard. Returns a decision that the CLI
 * executes. Kept pure for testability; the CLI maps it to exec/exit.
 */
export type ShimDecision =
  | { kind: "no-binary"; exitCode: 127; stderr: string }
  | { kind: "exec"; bin: string; argv: string[] }
  | { kind: "refused"; exitCode: 1; stderr: string[] };

export function decideShim(
  realArgs: string[],
  env: Record<string, string | undefined>,
  ctx: { home?: string; listIds?: Set<string> | null },
): ShimDecision {
  const home = ctx.home ?? process.env.HOME ?? "/home/toxic";
  const bin = resolvePitchforkBin(env, home);
  if (!bin)
    return { kind: "no-binary", exitCode: 127, stderr: NO_BINARY_MESSAGE };

  // status->list shortcut executes BEFORE the sovereign/ guard (bash order).
  if (
    normalizeStatusToList(realArgs).length === 1 &&
    realArgs[0] === "status"
  ) {
    return { kind: "exec", bin, argv: ["list"] };
  }

  if (isLifecycleSubcommand(realArgs[0])) {
    const ids = ctx.listIds ?? detectIds(bin);
    const decision = decideLifecycleArgs(realArgs, ids);
    if (decision.kind === "refused") {
      return { kind: "refused", exitCode: 1, stderr: decision.stderr };
    }
  }

  return { kind: "exec", bin, argv: realArgs };
}

/** Helper to fetch the registry id set by shelling out to the real `list`. */
export function detectIds(bin: string): Set<string> {
  try {
    const out = Bun.spawnSync([bin, "list"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return extractListIds(out.stdout?.toString() ?? "");
  } catch {
    return new Set<string>();
  }
}
