#!/usr/bin/env bun
/**
 * pitchfork-drift.ts — anomaly #6 (pitchfork two-truth) drift checker.
 *
 * The estate's live truth is the pitchfork.toml MONOLITH (196 daemons). The
 * pitchfork.d/ fragments (103 files) are dead litter the monolith SHADOWS
 * (pitchfork does not merge them). This detector statically compares the two
 * and reports PER FRAGMENT:
 *   - "shadowed": daemon.fragment.mdl exists in the monolith too (redundant copy)
 *   - "orphan":   daemon exists ONLY in a fragment (would never load from the
 *                 monolith => a genuinely dead config the operator may archive)
 * Exit: 0 = no orphans (every fragment daemon is either shadowed or expected dead);
 *       2 = orphans found (drift: something in a fragment never reaches the live truth).
 *
 * Mirrors the config-drift-detector prior-art (skills.rest): SSOT (monolith)
 * vs derived/dead fragments.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MONO = "/home/toxic/estate/pitchfork.toml";
const FRAG_DIR = "/home/toxic/estate/pitchfork.d";

/** Collect daemon names under `[daemons.<name>]` / `[daemons.<name>...]`. */
function daemonsIn(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^\[daemons\.([^\]\.]+)\.?/.exec(line.trim());
    if (m) names.add(m[1]!);
  }
  return names;
}

const monoText = readFileSync(MONO, "utf-8");
const mono = daemonsIn(monoText);

const shadowed: string[] = []; // defined in BOTH monolith + fragment (redundant copy)
const orphans: string[] = []; // defined ONLY in a fragment (would never load)

for (const f of readdirSync(FRAG_DIR).filter((x) => x.endsWith(".toml"))) {
  let fragText: string;
  try {
    fragText = readFileSync(join(FRAG_DIR, f), "utf-8");
  } catch {
    continue;
  }
  const frag = daemonsIn(fragText);
  for (const name of frag) {
    if (mono.has(name)) shadowed.push(`${name} (${f})`);
    else orphans.push(`${name} (${f})`);
  }
}

console.log("pitchfork drift checker");
console.log(`  monolith daemons      : ${mono.size}`);
console.log(`  pitchfork.d fragments : ${readdirSync(FRAG_DIR).filter((x) => x.endsWith(".toml")).length} files`);
console.log(`  shadowed (dup copy)   : ${shadowed.length}`);
console.log(`  orphanned (dead-only) : ${orphans.length}`);
if (orphans.length) {
  console.log("  orphan fragments (defined only in pitchfork.d, never reach live truth):");
  for (const o of orphans.slice(0, 30)) console.log(`    - ${o}`);
}
console.log(orphans.length === 0 ? "RESULT: no drift (every fragment daemon is shadowed AND loaded by monolith)." : "RESULT: drift detected — orphans would never load.");
process.exit(orphans.length ? 2 : 0);