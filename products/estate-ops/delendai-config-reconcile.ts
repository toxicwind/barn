#!/usr/bin/env bun
/**
 * delendai-config-reconcile — audit + reconcile the per-repo `delendai.config.json`
 * fleet against the estate governance policy.
 *
 * WHY: ~41 repos each carry a `delendai.config.json` (mostly JSONC w/ comments).
 * Their governance fields (development.profile, development.branches.integration,
 * validationMatrix.scopes) drift silently. This tool reports that drift against a
 * policy and optionally rewrites the volatile governance fields to match.
 *
 * Policy (estate doctrine): every requested delendai repo should declare
 *   development.profile = "shared-checkout-merge"
 *   development.branches.integration = "main"
 *   validationMatrix.scopes."default" = [ { command: "git diff --check", expect: "" } ]
 * Plugin-specific keys (plugins, tools, shell env) are per-repo and never touched.
 *
 * Usage:
 *   bun delendai-config-reconcile.ts                # drift report (dry-run)
 *   bun delendai-config-reconcile.ts --apply        # reconcile governance fields
 *   bun delendai-config-reconcile.ts --base /pens   # scan root (default /home/toxic/pens)
 *   bun delendai-config-reconcile.ts --test         # run the self-test (TDD)
 *
 * No secrets are read or written. JSONC is parsed via native Bun.JSONC.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PENS = "/home/toxic/pens";
const DISCOVER_EXCLUDE = [
  ".cache",
  "node_modules",
  ".git",
  "build",
  "docs",
  "extensions",
  "tests",
  ".retired",
  ".retired-squawk-20261024",
];

const POLICY = {
  profile: "shared-checkout-merge",
  integration: "main",
  defaultScope: {
    command: "git diff --check",
    expect: "",
  },
} as const;

type Row = {
  path: string;
  profile: string;
  integration: string;
  gate: "Y" | "N";
  drifts: string[];
};

let apply = false;
let scanBase = PENS;
for (const a of process.argv.slice(2)) {
  if (a === "--apply") apply = true;
  else if (a === "--base") scanBase = process.argv[process.argv.indexOf(a) + 1];
}

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (DISCOVER_EXCLUDE.includes(e)) continue;
    const p = join(dir, e);
    if (existsSync(join(p, "delendai.config.json")))
      out.push(join(p, "delendai.config.json"));
    if (existsSync(p)) walk(p, out);
  }
}

function parseJSONC(text: string): unknown {
  // @ts-ignore Bun.JSONC exists on this runtime
  return Bun.JSONC.parse(text);
}

function audit(): Row[] {
  const configs: string[] = [];
  walk(scanBase, configs);
  const rows: Row[] = [];
  for (const f of configs) {
    let d: any;
    try {
      d = parseJSONC(readFileSync(f, "utf8"));
    } catch {
      rows.push({
        path: f,
        profile: "<parse-err>",
        integration: "",
        gate: "N",
        drifts: ["unparseable JSONC"],
      });
      continue;
    }
    const dev = d?.development ?? {};
    const br = dev.branches ?? {};
    const vm = d?.validationMatrix ?? {};
    const profile = dev.profile ?? "NONE";
    const integration = br.integration ?? "";
    const gate = vm.scopes ? "Y" : "N";
    const drifts: string[] = [];
    if (profile !== POLICY.profile)
      drifts.push(`profile=${profile}≠${POLICY.profile}`);
    if (integration !== POLICY.integration)
      drifts.push(
        `integration=${integration || "<none>"}≠${POLICY.integration}`,
      );
    if (gate !== "Y") drifts.push("missing validationMatrix.scopes");
    rows.push({ path: f, profile, integration, gate, drifts });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function printReport(rows: Row[]) {
  console.log(
    `\n== delendai-config-reconcile | base=${scanBase} | ${rows.length} configs${apply ? " | APPLY" : " | dry-run"} ==\n`,
  );
  console.log(
    "path".padEnd(74) + "profile".padEnd(24) + "integ".padEnd(8) + "gate",
  );
  let driftCount = 0;
  for (const r of rows) {
    const flag = r.drifts.length ? ` <- ${r.drifts.join("; ")}` : "";
    if (r.drifts.length) driftCount++;
    console.log(
      r.path.slice(0, 70).padEnd(74) +
        r.profile.slice(0, 22).padEnd(24) +
        (r.integration || "-").padEnd(8) +
        r.gate +
        flag,
    );
  }
  console.log(`\ndrifting: ${driftCount}/${rows.length}`);
  return driftCount;
}

function applyReconcile(rows: Row[]) {
  let changed = 0;
  for (const r of rows) {
    if (!r.drifts.length || r.profile === "<parse-err>") continue;
    const f = r.path;
    const text = readFileSync(f, "utf8");
    // Rewrite the volatile governance fields. preserve the rest byte-for-byte.
    let next = text;
    const devStart = next.search(/(["']development["']\s*:\s*\{)/);
    next = next.replace(
      /(["']profile["']\s*:\s*).*?([,}])/,
      `$1"${POLICY.profile}"$2`,
    );
    // integration set inside development.branches if present else leave
    if (/["']integration["']/.test(next)) {
      next = next.replace(
        /(["']integration["']\s*:\s*)(["'])[^"']*(["'])/,
        `$1${POLICY.integration === "main" ? '"main"' : ""}`,
      );
    }
    // ensure a default validation scope exists (add validationMatrix block if absent)
    if (!/["']scopes["']/.test(next)) {
      const scopeBlock = `\n  "validationMatrix": {\n    "scopes": {\n      "default": [\n        { "command": "git diff --check", "expect": "" }\n      ]\n    }\n  }`;
      // insert before final closing brace
      const lastBrace = next.lastIndexOf("}");
      next =
        next.slice(0, lastBrace) +
        scopeBlock +
        "\n}" +
        next.slice(lastBrace + 1);
    }
    if (next !== text) {
      writeFileSync(f, next);
      changed++;
      console.log(`reconciled ${f}`);
    }
  }
  console.log(`\nreconciled ${changed} file(s)`);
}

// TDD self-test
function selfTest(): boolean {
  const sample = `{
  "$schema": "https://unpkg.com/@delendai/core/schema/delendai.config.schema.json",
  "development": { "profile": "shared-checkout-merge", "branches": { "integration": "main" } }
}`;
  const parsed: any = parseJSONC(sample);
  const ok1 = parsed.development.profile === "shared-checkout-merge";
  const errOnly = parseJSONC(`// comment\n{"a":1}`);
  const ok2 = errOnly.a === 1;
  console.log(
    `self-test: profile=${parsed.development.profile} ok1=${ok1} ok2=${ok2}`,
  );
  return ok1 && ok2;
}

if (process.argv.includes("--test")) {
  process.exit(selfTest() ? 0 : 1);
}

const rows = audit();
printReport(rows);
if (apply) applyReconcile(rows);
