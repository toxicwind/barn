#! /usr/bin/env bun
/**
 * cmdlog.ts — anti-truncation command runner for background/agent shells.
 *
 * Fixes the recurring "Process is running. Use read_process_output" truncation:
 * the tool's per-chunk "Initial output" capture is bounded, so long/multi-command
 * output is silently missed. cmdlog instead:
 *   1. spawns the command, teeing EVERY line to an unbounded file
 *      (/home/toxic/.hardened-reorg/cmdlog-<n>.out);
 *   2. prints a bounded "tail" view (like the tool would) PLUS the full file path;
 *   3. exits 0 only if the command exited 0.
 * The reader then reads the FULL capture from the file (never truncated).
 *
 * Usage:
 *   cmdlog -- '[your command with args...]'   # unbounded file capture + bounded preview
 *   cmdlog --head 0 -- '[cmd]'                # print nothing to stdout; file only
 *   cmdlog --lines 500 -- '[cmd]'             # preview up to 500 prepended lines
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "/home/toxic/.hardened-reorg";
mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
// parse --lines N
let previewLimit = 40;
if (args[0] === "--lines") { previewLimit = Number(args[1]); args.splice(0, 2); }
let previewLines = previewLimit;
if (args[0] === "--") args.shift(); // drop leading --

const file = join(OUT_DIR, `cmdlog-${process.pid}-${Date.now()}.out`);
const out = createWriteStream(file, { flags: "w" });
const cmd = args[0];
const rest = args.slice(1);

const child = spawn(cmd, rest, { stdio: ["ignore", "pipe", "pipe"] });
let collected: string[] = [];    // full ring to count preview lines
let preview: string[] = [];

child.stdout.on("data", (d: Buffer) => {
  out.write(d);
  const lines = d.toString().split("\n");
  for (const l of lines) {
    if (preview.length < previewLines + 1) preview.push(l);
    collected.push(l);
  }
});
child.stderr.on("data", (d: Buffer) => { out.write(d); });

child.on("close", (code) => {
  out.end();
  // bounded preview (stdlib-like) + the UNBOUNDED file path
  const pv = preview.slice(0, previewLines);
  process.stdout.write(pv.join("\n") + (pv.length ? (pv.at(-1) === "" ? "" : "\n") : ""));
  process.stdout.write(`\n[cmdlog: ${collected.length} lines → ${file}]\n`);
  process.exit(code ?? 1);
});