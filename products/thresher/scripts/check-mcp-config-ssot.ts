#!/usr/bin/env bun
// check-mcp-config-ssot.ts — fail closed if a second THRESHER-schema
// mcp_config.json appears outside the live SSOT.
//
// Ground truth (2026-11-08, Thread 2): the live :25127 process loads
//   pens/barn/products/thresher/mcp_config.json  (via --config=)
// That is the ONLY Pens gateway config. The census found:
//   - bornite/mesh/gateway/mcp_config.json  -> DIFFERENT schema (mcpServers is
//     a LIST, bornite's own gateway) — NOT a thresher shadow, excluded.
//   - *.codeium/windsurf/mcp_config.json    -> vendored third-party configs
//     inside cloned repos — excluded.
// A thresher-schema copy (top-level mcpServers is a DICT) anywhere else is a
// two-truths defect (anomaly #6, root AGENTS.md §5) and fails this gate.
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const PENS = process.env.PENS_ROOT ?? "/home/toxic/pens";
const SSOT = process.env.SSOT_PATH ?? join(PENS, "control-plane/ssot/mcp_config.json");
const SKIP = new Set(["node_modules", ".git", "archive", "dist", "build", "target", "vendor", ".cache", "__pycache__"]);
const ALLOW_SUFFIX = [".bak", ".off", ".retired", ".dist", ".example"];

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, acc);
    else if (e === "mcp_config.json") acc.push(p);
  }
  return acc;
}

// A thresher-schema config has top-level `mcpServers` as an OBJECT (dict of
// name -> server). Bornite's gateway uses a LIST. Vendored .codeium configs
// are third-party and excluded by path.
function isThresherSchema(p: string): boolean {
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    return !!d && typeof d === "object" && !!d.mcpServers && typeof d.mcpServers === "object" && !Array.isArray(d.mcpServers);
  } catch {
    return false;
  }
}

const found = walk(PENS);
const offenders = found.filter(
  (p) => p !== SSOT && !ALLOW_SUFFIX.some((s) => p.endsWith(s)) && !p.includes("/.codeium/") && isThresherSchema(p),
);

if (!existsSync(SSOT)) {
  console.error(`FAIL: SSOT missing: ${SSOT}`);
  process.exit(2);
}
if (offenders.length) {
  console.error(`FAIL: ${offenders.length} extra thresher-schema mcp_config.json (SSOT is thresher):`);
  for (const o of offenders) console.error(`  - ${relative(PENS, o)}`);
  console.error(`\nFix: delete or tombstone (append .retired-<date>) each, then re-run.`);
  process.exit(1);
}
console.log(`OK: single MCP config SSOT (${relative(PENS, SSOT)}); ${found.length} candidate(s), 0 thresher-schema offenders`);