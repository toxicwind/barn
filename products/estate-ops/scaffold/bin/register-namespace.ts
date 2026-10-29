#!/usr/bin/env bun
/**
 * register-namespace.ts — idempotently register a pen as a pitchfork namespace.
 *
 * Edits ~/.config/pitchfork/config.toml:
 *   [namespaces.<pen>]
 *   dir = "/home/toxic/pens/<pen>"
 *
 * Never duplicates a namespace; creates the file if missing.
 * Usage: bun register-namespace.ts <pen> [pen...]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CONFIG = "/home/toxic/.config/pitchfork/config.toml";
const pens = process.argv.slice(2);
if (pens.length === 0) {
  console.error("usage: bun register-namespace.ts <pen> [pen...]");
  process.exit(2);
}

let text = "";
try {
  text = await readFile(CONFIG, "utf8");
} catch {
  text = "[daemons]\n\n";
}

let changed = false;
for (const pen of pens) {
  const marker = `[namespaces.${pen}]`;
  if (text.includes(marker)) {
    console.log(`[ns] ${pen}: already registered`);
    continue;
  }
  if (!text.includes("[namespaces.")) {
    text += "\n";
  }
  text += `\n[namespaces.${pen}]\ndir = "/home/toxic/pens/${pen}"\n`;
  console.log(`[ns] ${pen}: registered -> /home/toxic/pens/${pen}`);
  changed = true;
}

if (changed) {
  await mkdir(dirname(CONFIG), { recursive: true });
  await writeFile(CONFIG, text, "utf8");
  console.log(`[ns] wrote ${CONFIG}`);
}
