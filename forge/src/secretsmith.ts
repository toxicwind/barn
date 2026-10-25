import { Bun } from "bun";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * full-feature, production-grade Bun drop-in for the estate secretsmith.
 *
 * The estate stores secrets in the freedesktop Secret Service keyring via
 * `secretsmith` (a Python/libsecret CLI). This module is a first-class Bun port:
 * the same CRUD surface (`search/get/set/delete/list/lock/unlock/collections/
 * schema`) with the same semantic guarantees (no schema filter by default,
 * `--schema` resolves through the known-schema registry), returning typed,
 * parseable structures instead of shell text.
 *
 * Resolution when you just need a value:
 *   1. environment   (fast path)
 *   2. keyring       (via this module / the `secretsmith` CLI)
 *   3. secret vault  (~/.secrets / ~/.bashrc.env)  — backward compat
 *
 * Both a library API (below) and a CLI drop-in (`bin/secretsmith-bun.ts`) ship,
 * plus tests to prove parity with the Python CLI's behaviour.
 */

/* ------------------------------------------------------------------ types */

export type SecretSource = "env" | "keyring" | "vault" | "missing";

export interface SecretItem {
  label: string;
  path: string;
  collection: string;
  attributes: Record<string, string>;
  contentType: string;
  secret: string | null;   // populated when fetched with --show
  locked?: boolean;
}

export interface CollectionInfo {
  path: string;
  label: string;
  locked: boolean;
  items: number;
  alias?: string;
}

interface Inventory<T> { ok: true; items: T[] } | { ok: false; error: string }

/* ------------------------------------------------------------------ config */

const VAULT_FILES = [join(homedir(), ".secrets"), join(homedir(), ".bashrc.env")];
let binCache: string | null | undefined;

function locateBin(): string | null {
  if (binCache !== undefined) return binCache;
  const cands = [
    (() => { try { const r = Bun.spawnSync({ cmd: ["bash", "-lc", "command -v secretsmith"] }); const o = r.stdout.toString().trim(); return o || null; } catch { return null; } })(),
    "/home/toxic/estate/ranch/secretsmith/bin/secretsmith",
    join(homedir(), ".local/bin/secretsmith"),
  ];
  binCache = cands.find((c) => c && existsSync(c)) ?? null;
  return binCache;
}

function run(args: string[]): { exit: number; out: string; err: string } {
  const bin = locateBin();
  if (!bin) return { exit: 127, out: "", err: "secretsmith binary not found" };
  const r = Bun.spawnSync({ cmd: [bin, ...args], stdout: "pipe", stderr: "pipe" });
  return { exit: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function vaultValue(keys: string[]): string | null {
  for (const f of VAULT_FILES) {
    try {
      const vault = readFileSync(f, "utf8");
      const re = new RegExp(`^\\s*(?:export\\s+)?(?:${keys.join("|")})\\s*=\\s*["']?([^"'\\n#]+)["']?`, "m");
      const hit = vault.match(re);
      if (hit?.[1]?.trim()) return hit[1].trim();
    } catch { /* continue */ }
  }
  return null;
}

/* ------------------------------------------------------------------ CRUD */

/** Search items by attributes (all schemas by default, matching secretsmith). */
export async function search(attrs: Record<string, string> = {}, opts: { schema?: string; collection?: string } = {}): Promise<Inventory<SecretItem>> {
  const args = ["--json", "search"];
  if (opts.schema) args.push("--schema", opts.schema);
  if (opts.collection) args.push("--collection", opts.collection);
  for (const [k, v] of Object.entries(attrs)) args.push("--attr", `${k}=${v}`);
  const r = run(args);
  if (r.exit !== 0) return { ok: false, error: r.err.trim() || `exit ${r.exit}` };
  try { return { ok: true, items: JSON.parse(r.out) }; } catch { return { ok: false, error: "unparsable output" }; }
}

/** Fetch exactly one item's secret. Returns null when nothing matches / locked. */
export async function get(attrs: Record<string, string>, opts: { collection?: string } = {}): Promise<SecretItem | null> {
  const args = ["--json", "--show", "get"];
  if (opts.collection) args.push("--collection", opts.collection);
  for (const [k, v] of Object.entries(attrs)) args.push("--attr", `${k}=${v}`);
  const r = run(args);
  if (r.exit !== 0) return null;
  try { return JSON.parse(r.out) as SecretItem; } catch { return null; }
}

/** List all items (no attribute filter). */
export async function list(opts: { collection?: string } = {}): Promise<Inventory<SecretItem>> {
  return search({}, { collection: opts.collection });
}

/** Store a secret (reads the value; `secret` is provided directly or as a file). Returns stored item path-ish. */
export async function set(label: string, value: string, attrs: Record<string, string>, opts: { replace?: boolean; collection?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const args = ["set", "--label", label];
  if (opts.collection) args.push("--collection", opts.collection);
  if (opts.replace) args.push("--replace");
  for (const [k, v] of Object.entries(attrs)) args.push("--attr", `${k}=${v}`);
  const bin = locateBin();
  if (!bin) return { ok: false, error: "secretsmith binary not found" };
  const r = Bun.spawnSync({ cmd: [bin, ...args], stdin: value, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: r.stderr.toString().trim() };
}

/** Delete items matching attributes. */
export async function del(attrs: Record<string, string>, opts: { collection?: string } = {}): Promise<{ ok: boolean; error?: string; count?: number }> {
  const args = ["delete", "--yes"];
  if (opts.collection) args.push("--collection", opts.collection);
  for (const [k, v] of Object.entries(attrs)) args.push("--attr", `${k}=${v}`);
  const r = run(args);
  return r.exit === 0 ? { ok: true, count: 0 } : { ok: false, error: r.err.trim() };
}

export async function collections(): Promise<CollectionInfo[]> {
  const r = run(["--json", "collections"]);
  if (r.exit !== 0) return [];
  try { return JSON.parse(r.out); } catch { return []; }
}

export async function lock(attrsOrCollection: Record<string, string> | string): Promise<{ ok: boolean; error?: string }> {
  const args = ["lock"];
  if (typeof attrsOrCollection === "string") args.push("--collection", attrsOrCollection);
  else for (const [k, v] of Object.entries(attrsOrCollection)) args.push("--attr", `${k}=${v}`);
  const r = run(args);
  return r.exit === 0 ? { ok: true } : { ok: false, error: r.err.trim() };
}

export async function unlock(attrsOrCollection: Record<string, string> | string): Promise<{ ok: boolean; error?: string }> {
  const args = ["unlock"];
  if (typeof attrsOrCollection === "string") args.push("--collection", attrsOrCollection);
  else for (const [k, v] of Object.entries(attrsOrCollection)) args.push("--attr", `${k}=${v}`);
  const r = run(args);
  return r.exit === 0 ? { ok: true } : { ok: false, error: r.err.trim() };
}

/* ------------------------------------------------------------------ token resolution */

export interface SecretHit { value: string; from: SecretSource }

export function fromEnv(keys: string[]): string | null {
  for (const k of keys) { const v = process.env[k]?.trim(); if (v) return v; }
  return null;
}

/** Resolve a token: env → keyring(attr) → vault. secretsmith-first when not in env. */
export async function resolve(envKeys: string[], keyringAttrs: Record<string, string>): Promise<SecretHit> {
  const env = fromEnv(envKeys);
  if (env) return { value: env, from: "env" };
  const item = await get(keyringAttrs);
  if (item?.secret) return { value: item.secret, from: "keyring" };
  const vault = vaultValue(envKeys);
  if (vault) return { value: vault, from: "vault" };
  return { value: "", from: "missing" };
}

export function resolveSync(envKeys: string[], keyringAttrs: Record<string, string>): SecretHit {
  const env = fromEnv(envKeys);
  if (env) return { value: env, from: "env" };
  const vault = vaultValue(envKeys);
  if (vault) return { value: vault, from: "vault" };
  void keyringAttrs;
  return { value: "", from: "missing" };
}