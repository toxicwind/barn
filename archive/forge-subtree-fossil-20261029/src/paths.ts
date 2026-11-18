/**
 * Path resolution — no hardcoded host paths anywhere in this skill.
 *
 * pens order: $pens env override → discovery from this file's own
 * location (a config/ports.env marker two levels above the skill dir) →
 * the first *existing* candidate of the well-known pens locations.
 * Candidates are probed with existsSync, never assumed: on a host with no
 * pens checkout the resolver reports the miss as an empty string instead
 * of blessing a stale directory, so no phantom path like /home/hatch/pens
 * ever leaks into reports or indexes.
 *
 * Mirrors the Python resolver at $SKILLS_HOME/lib/pens_paths.py and the bash
 * one at $SKILLS_HOME/lib/pens.sh. Three resolvers, one order, so a report
 * generated from Python, bash or Bun names the same file.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const HOME = process.env.HOME ?? "/home/toxic";

/** pens/skills/pattern-forge/src/paths.ts → pens/skills/pattern-forge */
export const SKILL_DIR = dirname(dirname(new URL(import.meta.url).pathname));

/** Well-known pens locations, probed in order. Probed, never assumed.
 * Deduped: on yote $HOME is /home/toxic so both entries coincide. */
export function pensCandidates(): string[] {
  return [...new Set(["/home/toxic/pens/pens", join(HOME, "pens")])];
}

/** First existing candidate wins; the fallback is returned when none exist. */
export function pickFirstExisting(candidates: readonly string[], fallback: string): string {
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* probe next */
    }
  }
  return fallback;
}

/**
 * Resolve the pens root. Returns "" on a host with no pens checkout —
 * the honest miss. Callers must not build paths off the miss (see
 * pensSub): an empty pens means "not applicable here", never a
 * directory that does not exist.
 */
function discoverpens(): string {
  const fromSkill = resolve(SKILL_DIR, "..", "..");
  if (existsSync(join(fromSkill, "config", "ports.env"))) return fromSkill;
  return pickFirstExisting(pensCandidates(), "");
}

/** The probe chain, for `forge paths` / doctor reporting: every candidate,
// whether it exists, and which one the resolver selected. On an honest
// miss (no pens on this host) nothing is selected. */
export function probepens(): { candidate: string; exists: boolean; selected: boolean }[] {
  return pensCandidates().map((candidate) => ({
    candidate,
    exists: existsSync(candidate),
    selected: pens_ROOT !== "" && resolve(candidate) === pens_ROOT,
  }));
}

/**
 * The pens root: $pens when explicitly set, otherwise the discovered
 * location, otherwise "" (honest miss — no pens checkout on this host).
 * resolve() is never called on the miss: resolve("") would bless the
 * current working directory, which is exactly the stale-path bug this
 * resolver exists to avoid.
 */
const pens_ROOT = process.env.pens ? resolve(process.env.pens) : discoverpens();

/** realpath when it exists, so compat symlinks never leak into reports. */
export function resolvePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A path under the pens root: env override wins, otherwise join under
 * pens, otherwise "" — never a path off a missed pens. An explicit env
 * override is honored even when it does not exist (the operator pointed at
 * it on purpose; doctor flags it as missing).
 */
function pensSub(envKey: string, ...parts: string[]): string {
  const fromEnv = process.env[envKey];
  if (fromEnv) return resolvePath(fromEnv);
  if (!pens_ROOT) return "";
  return resolvePath(join(pens_ROOT, ...parts));
}

export const pens = pens_ROOT ? resolvePath(pens_ROOT) : "";
export const RANCH = pensSub("RANCH", "ranch");
export const VENDORED = pensSub("VENDORED", "vendored");
export const VAR = pensSub("VAR", "var");
export const MANOR = pensSub("MANOR", "manor");
export const SKILLS_HOME = pensSub("SKILLS_HOME", "skills");
export const TAU_DIR = process.env.TAU_DIR ? resolvePath(process.env.TAU_DIR) : RANCH ? resolvePath(join(RANCH, "tau")) : "";
export const PORTS_ENV = pensSub("PORTS_ENV", "config", "ports.env");
export const KNOWLEDGEBASE = pensSub("KNOWLEDGEBASE", "docs", "fleet-knowledgebase.md");

/** Compatibility aliases — the Python resolver exports these same names. */
export const PORT_SSOT = PORTS_ENV;
export const TAU = TAU_DIR;

/** Winners ledger: shared with the Python engine so hedged ordering carries over. */
export const WINNERS_LOG = process.env.WINNERS_LOG
  ? resolve(process.env.WINNERS_LOG)
  : VAR
    ? resolve(join(VAR, "cache", "pattern-forge", "winners.jsonl"))
    : "";

/** Directories that are never worth indexing. */
export function isRepoRoot(path: string): boolean {
  return existsSync(join(path, ".git")) || existsSync(join(path, ".git", "HEAD"));
}

export type Tier = "pens" | "ranch" | "vendored" | "var" | "manor" | "external";

/** Which pens tier a path belongs to, for grouping and exclusion rules. */
export function tierOf(path: string): Tier {
  // startsWith("") is true for everything, so an empty tier root would
  // misclassify every path as that tier. On an honest miss every path is
  // external.
  if (!pens) return "external";
  const p = resolvePath(path);
  if (RANCH && p.startsWith(RANCH)) return "ranch";
  if (VENDORED && p.startsWith(VENDORED)) return "vendored";
  if (VAR && p.startsWith(VAR)) return "var";
  if (MANOR && p.startsWith(MANOR)) return "manor";
  if (p.startsWith(pens)) return "pens";
  return "external";
}