#!/usr/bin/env bun
/**
 * exec.ts — run a shell command across every product of a pen (or all pens).
 * The pens analog of `moon run` / `meta exec` / `repo forall`.
 *
 * Usage:
 *   bun exec.ts             # print every product in the five pens
 *   bun exec.ts --pen=ranch "git status --short"   # one pen
 *   bun exec.ts "git log -1 --oneline"              # all pens
 *   bun exec.ts --pen=geode --timeout=20000 "bun test"
 *
 * Discovers product dirs at <pen>/products/* (own .git|package.json|go.mod|
 * Cargo.toml); exits nonzero if any subcommand fails. Never recurses into
 * nested dirs — products only.
 */
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const PENS_ROOT = "/home/toxic/pens";
const PENS = ["estate", "geode", "barn", "ranch", "olympus"];

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function isProduct(dir: string): Promise<boolean> {
  for (const m of [".git", "package.json", "go.mod", "Cargo.toml"]) {
    try {
      await stat(join(dir, m));
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

const argv = process.argv.slice(2);
const penArg = argv.find((a) => a.startsWith("--pen="))?.split("=")[1];
const timeoutArg = Number(
  argv.find((a) => a.startsWith("--timeout="))?.split("=")[1] ?? 30000,
);
const command = argv.filter((a) => !a.startsWith("--")).join(" ");
const targets = penArg ? [penArg] : PENS;

const products: Array<{ pen: string; name: string; dir: string }> = [];
for (const pen of targets) {
  const pdir = join(PENS_ROOT, pen, "products");
  if (!(await isDir(pdir))) continue;
  for (const name of (await readdir(pdir)).sort()) {
    const full = join(pdir, name);
    if (!(await isDir(full))) continue;
    if (await isProduct(full)) products.push({ pen, name, dir: full });
  }
}

if (!command) {
  console.log("products:");
  for (const p of products) console.log(`  ${p.pen}/${p.name}  (${p.dir})`);
  process.exit(0);
}

let failed = 0;
for (const p of products) {
  process.stdout.write(`[${p.pen}/${p.name}] ${command}\n`);
  const r = spawnSync("bash", ["-lc", command], {
    cwd: p.dir,
    timeout: timeoutArg,
    encoding: "utf8",
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    process.stderr.write(`  !! ${p.pen}/${p.name}: exit ${r.status}\n`);
    failed++;
  }
}
process.stderr.write(`done: ${products.length} products, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
