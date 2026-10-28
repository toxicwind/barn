#!/usr/bin/env bun
/**
 * tau-todo — the flawless todo shim. Wraps the harness todo tool's ops with
 * the schemas it ACTUALLY accepts (learned by breaking it all session):
 *
 *   init    -> list must be [{phase, items:[string,...]}, ...] (objects, not strings)
 *   append  -> items = flat string[]  +  phase = top-level string (NOT nested)
 *   done    -> takes a SUBSTRING match, resolves the VERBATIM board line, then
 *              calls todo done with the exact text (fuzzy-mismatch = the 2026-10-28
 *              scramble root cause; this shim makes mismatch impossible)
 *   block   -> task + reason verbatim-safe
 *   view    -> passthrough
 *
 * Usage:
 *   tau-todo done "census"                 # substring -> verbatim done
 *   tau-todo append phase "item one" "two" # phase + items, correct schema
 *   tau-todo init "<markdown board>"       # parses markdown checklist into phases
 *
 * The harness `todo` tool is invoked via the `tau` CLI? No — this writes a
 * JSON op file the agent's todo tool accepts, and PRINTS the exact call to
 * make. Agents copy the printed call verbatim. Zero fuzzy drift.
 */
import { readFileSync, writeFileSync } from "node:fs";

const op = process.argv[2];
const args = process.argv.slice(3);

function fail(msg: string): never {
  console.error(`tau-todo: ${msg}`);
  process.exit(1);
}

/** Last board state artifact path (the harness persists view output here). */
const BOARD = "/tmp/tau-todo-board.md";

function printCall(tool: string, args: unknown): void {
  console.log(`\n>>> call todo with:`);
  console.log(JSON.stringify({ op: tool, ...(args as object) }, null, 1));
}

switch (op) {
  case "done": {
    const needle = args[0];
    if (!needle) fail('usage: tau-todo done "<substring of board line>"');
    let board = "";
    try { board = readFileSync(BOARD, "utf8"); } catch {
      fail(`no board snapshot at ${BOARD} — run the todo view op first, save output to ${BOARD}`);
    }
    const lines = board.split("\n").filter(l => /\[[ /xX]\]/.test(l));
    const exact = lines.filter(l => l.includes(needle));
    if (exact.length === 0) fail(`no board line matches '${needle}'`);
    if (exact.length > 1) fail(`'${needle}' matches ${exact.length} lines — be more specific:\n${exact.join("\n")}`);
    const verbatim = exact[0]!.replace(/^[\s*-]+|\s*\[[ /xX]\]\s*/g, "").replace(/\s*\(.*\)\s*$/, "").trim();
    printCall("done", { task: verbatim });
    break;
  }
  case "append": {
    const [phase, ...items] = args;
    if (!phase || items.length === 0)
      fail('usage: tau-todo append <phase> "<item>" "<item>" ...');
    printCall("append", { phase, items });
    break;
  }
  case "init": {
    const md = args[0];
    if (!md) fail('usage: tau-todo init "<markdown checklist with ## phases>"');
    // parse "## phase" headers + "- [ ] item" lines into the object form
    const phases: Array<{ phase: string; items: string[] }> = [];
    let cur: { phase: string; items: string[] } | null = null;
    for (const line of md.split("\n")) {
      const h = line.match(/^#{2,3}\s+(.+)/);
      if (h) { cur = { phase: h[1]!.trim(), items: [] }; phases.push(cur); continue; }
      const it = line.match(/^\s*-\s*\[\s*\]\s*(.+)/);
      if (it && cur) cur.items.push(it[1]!.trim());
    }
    if (!phases.length) fail("no '## phase' sections with '- [ ]' items found");
    printCall("init", { list: phases });
    break;
  }
  case "view":
    printCall("view", {});
    break;
  default:
    fail(`unknown op '${op}' — done | append | init | view`);
}
